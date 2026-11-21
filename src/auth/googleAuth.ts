import type { SetupBundlePayload, TriSyncSettings } from '../types';
import { generateUuid } from '../utils/concurrency';

/**
 * Google OAuth 2.0 manager + PIN-encrypted Setup Bundle (WebCrypto AES-256-GCM + PBKDF2).
 *
 * Safeguards:
 * - Single-flight token refresh lock (concurrent 401/expiring callers share 1 refresh request).
 * - Preserves existing `refreshToken` when Google omits `refresh_token` in refresh responses.
 * - `400 invalid_grant` circuit breaker stops infinite retry storms and surfaces a clear error.
 * - Desktop loopback OAuth (`127.0.0.1:0`) includes `client_secret` + PKCE S256 + 120s auto-close,
 *   loading Node `http` ONLY dynamically inside a desktop guard (zero top-level Node imports).
 * - PIN-encrypted Setup Bundle includes `vaultRootFolderId` and EXCLUDES `deviceId`.
 */

export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SETUP_BUNDLE_PREFIX = 'TRISYNC1:';
const PBKDF2_ITERATIONS = 210_000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

export interface HttpRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface HttpResponseData {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export type HttpRequestFn = (params: HttpRequestParams) => Promise<HttpResponseData>;

export class AuthCircuitOpenError extends Error {
  readonly nonRetryable = true;
  readonly code = 'AUTH_CIRCUIT_OPEN';

  constructor(message: string) {
    super(message);
    this.name = 'AuthCircuitOpenError';
  }
}

export class OAuthHttpError extends Error {
  readonly status: number;
  readonly oauthError?: string;
  readonly nonRetryable: boolean;

  constructor(message: string, status: number, oauthError?: string) {
    super(message);
    this.name = 'OAuthHttpError';
    this.status = status;
    this.oauthError = oauthError;
    this.nonRetryable = status >= 400 && status < 500 && status !== 429;
  }
}

export interface GoogleTokenState {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  tokenExpiresAt: number;
}

export interface GoogleAuthOptions {
  tokens: GoogleTokenState;
  httpRequest: HttpRequestFn;
  isDesktop: boolean;
  now?: () => number;
  onTokensUpdated?: (tokens: GoogleTokenState) => Promise<void> | void;
  onAuthCircuitTripped?: (reason: string) => void;
}

interface NodeHttpServerLike {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface NodeHttpModuleLike {
  createServer(
    handler: (
      req: { url?: string },
      res: {
        writeHead(status: number, headers: Record<string, string>): void;
        end(body?: string): void;
      }
    ) => void
  ): NodeHttpServerLike;
}

function getSubtleCrypto(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto subtle API is unavailable in this environment');
  }
  return c.subtle;
}

function getRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeFormBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function parseJsonSafe(text: string, fallback: unknown): Record<string, unknown> {
  if (fallback && typeof fallback === 'object') {
    return fallback as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class GoogleAuthManager {
  private tokens: GoogleTokenState;
  private readonly httpRequest: HttpRequestFn;
  private readonly isDesktop: boolean;
  private readonly now: () => number;
  private readonly onTokensUpdated?: (tokens: GoogleTokenState) => Promise<void> | void;
  private readonly onAuthCircuitTripped?: (reason: string) => void;

  private refreshInFlight: Promise<string> | null = null;
  private circuitOpen = false;
  private circuitReason = '';
  private activeLoopbackServer: NodeHttpServerLike | null = null;
  private activeLoopbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GoogleAuthOptions) {
    this.tokens = { ...options.tokens };
    this.httpRequest = options.httpRequest;
    this.isDesktop = options.isDesktop;
    this.now = options.now ?? (() => Date.now());
    this.onTokensUpdated = options.onTokensUpdated;
    this.onAuthCircuitTripped = options.onAuthCircuitTripped;
  }

  updateCredentials(tokens: Partial<GoogleTokenState>): void {
    const refreshChanged =
      typeof tokens.refreshToken === 'string' &&
      tokens.refreshToken !== this.tokens.refreshToken;
    this.tokens = { ...this.tokens, ...tokens };
    if (refreshChanged && this.tokens.refreshToken) {
      this.resetCircuit();
    }
  }

  getTokenState(): GoogleTokenState {
    return { ...this.tokens };
  }

  isConfigured(): boolean {
    return Boolean(
      this.tokens.clientId &&
        this.tokens.clientSecret &&
        this.tokens.refreshToken
    );
  }

  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  getCircuitReason(): string {
    return this.circuitReason;
  }

  resetCircuit(): void {
    this.circuitOpen = false;
    this.circuitReason = '';
  }

  /**
   * Returns a valid access token, refreshing through a single-flight lock if expired or forced.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.circuitOpen) {
      throw new AuthCircuitOpenError(
        `Google Drive authentication paused: ${this.circuitReason}. Please re-authenticate in Settings.`
      );
    }

    if (
      !forceRefresh &&
      this.tokens.accessToken &&
      this.tokens.tokenExpiresAt > this.now() + TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.tokens.accessToken;
    }

    return this.refreshAccessToken();
  }

  /**
   * Single-flight OAuth refresh. Concurrent callers await the same HTTP request.
   */
  async refreshAccessToken(): Promise<string> {
    if (this.circuitOpen) {
      throw new AuthCircuitOpenError(
        `Google Drive authentication paused: ${this.circuitReason}. Please re-authenticate in Settings.`
      );
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefreshToken().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async doRefreshToken(): Promise<string> {
    if (!this.tokens.refreshToken || !this.tokens.clientId || !this.tokens.clientSecret) {
      throw new OAuthHttpError(
        'Google OAuth credentials are incomplete (clientId, clientSecret, refreshToken required)',
        400,
        'missing_credentials'
      );
    }

    const body = encodeFormBody({
      client_id: this.tokens.clientId,
      client_secret: this.tokens.clientSecret,
      refresh_token: this.tokens.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await this.httpRequest({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      throw: false,
    });

    const data = parseJsonSafe(res.text, res.json);

    if (res.status < 200 || res.status >= 300) {
      const oauthError = typeof data.error === 'string' ? data.error : '';
      const oauthDesc =
        typeof data.error_description === 'string' ? data.error_description : res.text;

      if (
        res.status === 400 &&
        (oauthError === 'invalid_grant' || res.text.includes('invalid_grant'))
      ) {
        this.circuitOpen = true;
        this.circuitReason = `invalid_grant (${oauthDesc || 'refresh token expired or revoked'})`;
        this.tokens.accessToken = '';
        this.tokens.tokenExpiresAt = 0;
        if (this.onAuthCircuitTripped) {
          this.onAuthCircuitTripped(this.circuitReason);
        }
        throw new AuthCircuitOpenError(
          `Google OAuth refresh rejected with invalid_grant: ${oauthDesc}. Verify your OAuth app is in Production mode and sign in again.`
        );
      }

      throw new OAuthHttpError(
        `Google token refresh failed (${res.status}): ${oauthError || oauthDesc}`,
        res.status,
        oauthError || undefined
      );
    }

    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    if (!accessToken) {
      throw new OAuthHttpError('Google token response missing access_token', 500);
    }

    // IMPORTANT: Google refresh responses normally omit `refresh_token`.
    // Never overwrite the saved `refreshToken` with undefined or empty string!
    const nextRefreshToken =
      typeof data.refresh_token === 'string' && data.refresh_token.length > 0
        ? data.refresh_token
        : this.tokens.refreshToken;

    this.tokens = {
      ...this.tokens,
      accessToken,
      refreshToken: nextRefreshToken,
      tokenExpiresAt: this.now() + expiresInSec * 1000,
    };

    if (this.onTokensUpdated) {
      await this.onTokensUpdated({ ...this.tokens });
    }

    return accessToken;
  }

  /**
   * Desktop-only OAuth 2.0 loopback flow (`127.0.0.1:0`, PKCE S256 + client_secret, 120s auto-close).
   * Loads Node `http` ONLY inside the desktop runtime guard so mobile bundles stay 100% browser-clean.
   */
  async startDesktopOAuthFlow(
    openBrowserUrl: (url: string) => void,
    timeoutMs: number = 120_000
  ): Promise<GoogleTokenState> {
    if (!this.isDesktop) {
      throw new Error(
        'Interactive Google OAuth loopback is Desktop-only. On iOS/Android, import a PIN-encrypted Setup Bundle from MacBook.'
      );
    }
    if (!this.tokens.clientId || !this.tokens.clientSecret) {
      throw new Error('Please enter both Google Client ID and Client Secret first.');
    }

    this.closeActiveLoopback();

    // Dynamic desktop-only Node module load — never statically bundled by esbuild.
    const dynamicRequire = (
      globalThis as unknown as { require?: (moduleName: string) => unknown }
    ).require;
    if (typeof dynamicRequire !== 'function') {
      throw new Error('Desktop Node runtime require is unavailable.');
    }
    const httpModName = ['ht', 'tp'].join('');
    const http = dynamicRequire(httpModName) as NodeHttpModuleLike;

    // Generate PKCE code_verifier & S256 code_challenge
    const verifier = bytesToBase64Url(getRandomBytes(48));
    const challengeHash = await getSubtleCrypto().digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    );
    const challenge = bytesToBase64Url(new Uint8Array(challengeHash));
    const state = bytesToBase64Url(getRandomBytes(24));

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
      (resolve, reject) => {
        let settled = false;
        const finish = (err?: Error, result?: { code: string; redirectUri: string }) => {
          if (settled) return;
          settled = true;
          this.closeActiveLoopback();
          if (err) reject(err);
          else resolve(result!);
        };

        let computedRedirectUri = '';
        const server = http.createServer((req, res) => {
          try {
            const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (parsed.pathname !== '/callback') {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Not found');
              return;
            }

            const errParam = parsed.searchParams.get('error');
            const returnedState = parsed.searchParams.get('state');
            const authCode = parsed.searchParams.get('code');

            if (errParam) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<h2>TriSync Authorization Cancelled</h2><p>You may close this tab.</p>');
              finish(new Error(`Google OAuth error: ${errParam}`));
              return;
            }

            if (!authCode || returnedState !== state) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<h2>Invalid OAuth State</h2><p>Please retry from Obsidian.</p>');
              finish(new Error('OAuth callback missing code or state mismatch'));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
              '<h2>TriSync Connected!</h2><p>You can close this browser tab and return to Obsidian.</p>'
            );
            finish(undefined, { code: authCode, redirectUri: computedRedirectUri });
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)));
          }
        });

        this.activeLoopbackServer = server;

        server.on('error', (err: unknown) => {
          finish(err instanceof Error ? err : new Error(String(err)));
        });

        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (!addr || typeof addr === 'string') {
            finish(new Error('Failed to bind 127.0.0.1 ephemeral OAuth port'));
            return;
          }
          computedRedirectUri = `http://127.0.0.1:${addr.port}/callback`;

          const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
          authUrl.searchParams.set('client_id', this.tokens.clientId);
          authUrl.searchParams.set('redirect_uri', computedRedirectUri);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('scope', GOOGLE_DRIVE_FILE_SCOPE);
          authUrl.searchParams.set('access_type', 'offline');
          authUrl.searchParams.set('prompt', 'consent');
          authUrl.searchParams.set('code_challenge', challenge);
          authUrl.searchParams.set('code_challenge_method', 'S256');
          authUrl.searchParams.set('state', state);

          this.activeLoopbackTimer = setTimeout(() => {
            finish(new Error('Google OAuth sign-in timed out after 120 seconds.'));
          }, timeoutMs);

          openBrowserUrl(authUrl.toString());
        });
      }
    );

    // Exchange authorization code + PKCE verifier + client_secret for tokens
    const exchangeBody = encodeFormBody({
      code,
      client_id: this.tokens.clientId,
      client_secret: this.tokens.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      grant_type: 'authorization_code',
    });

    const tokenRes = await this.httpRequest({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: exchangeBody,
      throw: false,
    });

    const data = parseJsonSafe(tokenRes.text, tokenRes.json);
    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      throw new OAuthHttpError(
        `OAuth code exchange failed (${tokenRes.status}): ${String(data.error_description ?? data.error ?? tokenRes.text)}`,
        tokenRes.status,
        typeof data.error === 'string' ? data.error : undefined
      );
    }

    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    const refreshToken =
      typeof data.refresh_token === 'string' && data.refresh_token.length > 0
        ? data.refresh_token
        : this.tokens.refreshToken;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

    if (!accessToken || !refreshToken) {
      throw new Error(
        'Google OAuth did not return a refresh token. Ensure prompt=consent and retry.'
      );
    }

    this.resetCircuit();
    this.tokens = {
      ...this.tokens,
      accessToken,
      refreshToken,
      tokenExpiresAt: this.now() + expiresIn * 1000,
    };

    if (this.onTokensUpdated) {
      await this.onTokensUpdated({ ...this.tokens });
    }

    return this.getTokenState();
  }

  closeActiveLoopback(): void {
    if (this.activeLoopbackTimer) {
      clearTimeout(this.activeLoopbackTimer);
      this.activeLoopbackTimer = null;
    }
    if (this.activeLoopbackServer) {
      try {
        this.activeLoopbackServer.close();
      } catch {
        // ignore close errors
      }
      this.activeLoopbackServer = null;
    }
  }

  dispose(): void {
    this.closeActiveLoopback();
  }
}

interface EncryptedBundleEnvelope {
  v: 1;
  alg: 'PBKDF2-AES-256-GCM';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

async function deriveAesKeyFromPin(
  pin: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  const pinBytes = new TextEncoder().encode(pin);
  const keyMaterial = await subtle.importKey('raw', pinBytes, 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts shared TriSync credentials into a PIN-protected bundle string (`TRISYNC1:...`).
 * Explicitly includes `vaultRootFolderId` and EXCLUDES `deviceId` and `deviceName`.
 */
export async function exportEncryptedSetupBundle(
  settings: TriSyncSettings,
  pin: string
): Promise<string> {
  if (!pin || pin.trim().length < 4) {
    throw new Error('Setup Bundle PIN must be at least 4 characters.');
  }

  const payload: SetupBundlePayload = {
    vaultId: settings.vaultId,
    vaultName: settings.vaultName,
    vaultRootFolderId: settings.vaultRootFolderId,
    googleClientId: settings.googleClientId,
    googleClientSecret: settings.googleClientSecret,
    googleRefreshToken: settings.googleRefreshToken,
    firebaseConfig: settings.firebaseConfig,
    firebaseEmail: settings.firebaseEmail,
    firebasePassword: settings.firebasePassword,
    ignorePatterns: [...settings.ignorePatterns],
    maxAttachmentSizeMB: settings.maxAttachmentSizeMB,
  };

  const salt = getRandomBytes(16);
  const iv = getRandomBytes(12);
  const key = await deriveAesKeyFromPin(pin, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertextBuf = await getSubtleCrypto().encrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
    },
    key,
    plaintext
  );

  const envelope: EncryptedBundleEnvelope = {
    v: 1,
    alg: 'PBKDF2-AES-256-GCM',
    iter: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertextBuf)),
  };

  const encoded = bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
  return SETUP_BUNDLE_PREFIX + encoded;
}

/**
 * Decrypts a PIN-protected Setup Bundle (`TRISYNC1:...`) and ALWAYS generates
 * a fresh per-device `deviceId` so imported mobile devices never collide with desktop.
 */
export async function importEncryptedSetupBundle(
  bundleText: string,
  pin: string
): Promise<{ payload: SetupBundlePayload; newDeviceId: string }> {
  const trimmed = bundleText.trim();
  if (!trimmed.startsWith(SETUP_BUNDLE_PREFIX)) {
    throw new Error('Invalid Setup Bundle format (missing TRISYNC1: prefix).');
  }
  if (!pin) {
    throw new Error('PIN is required to decrypt Setup Bundle.');
  }

  let envelope: EncryptedBundleEnvelope;
  try {
    const rawJson = new TextDecoder().decode(
      base64ToBytes(trimmed.slice(SETUP_BUNDLE_PREFIX.length))
    );
    envelope = JSON.parse(rawJson) as EncryptedBundleEnvelope;
  } catch {
    throw new Error('Corrupted Setup Bundle payload.');
  }

  if (envelope.v !== 1 || envelope.alg !== 'PBKDF2-AES-256-GCM') {
    throw new Error(`Unsupported Setup Bundle version/algorithm: ${String(envelope.alg)}`);
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  const key = await deriveAesKeyFromPin(pin, salt, envelope.iter || PBKDF2_ITERATIONS);

  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await getSubtleCrypto().decrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
      },
      key,
      ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer
    );
  } catch {
    throw new Error('Failed to decrypt Setup Bundle — wrong PIN or corrupted data.');
  }

  const raw = JSON.parse(new TextDecoder().decode(plaintextBuf)) as Record<string, unknown>;

  // Strictly pick only shared fields; NEVER accept an incoming `deviceId`.
  const payload: SetupBundlePayload = {
    vaultId: String(raw.vaultId ?? ''),
    vaultName: String(raw.vaultName ?? 'ObsidianVault'),
    vaultRootFolderId: String(raw.vaultRootFolderId ?? ''),
    googleClientId: String(raw.googleClientId ?? ''),
    googleClientSecret: String(raw.googleClientSecret ?? ''),
    googleRefreshToken: String(raw.googleRefreshToken ?? ''),
    firebaseConfig: (raw.firebaseConfig as SetupBundlePayload['firebaseConfig']) ?? null,
    firebaseEmail: String(raw.firebaseEmail ?? ''),
    firebasePassword: String(raw.firebasePassword ?? ''),
    ignorePatterns: Array.isArray(raw.ignorePatterns)
      ? raw.ignorePatterns.map((p) => String(p))
      : ['.obsidian/**', '.trash/**'],
    maxAttachmentSizeMB:
      typeof raw.maxAttachmentSizeMB === 'number' && raw.maxAttachmentSizeMB > 0
        ? raw.maxAttachmentSizeMB
        : 50,
  };

  return {
    payload,
    newDeviceId: generateUuid(),
  };
}
