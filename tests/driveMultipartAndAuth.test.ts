import { describe, expect, it } from 'vitest';
import {
  AuthCircuitOpenError,
  GoogleAuthManager,
  exportEncryptedSetupBundle,
  importEncryptedSetupBundle,
  type HttpRequestFn,
  type HttpRequestParams,
  type HttpResponseData,
} from '../src/auth/googleAuth';
import {
  GoogleDriveClient,
  buildMultipartRelatedBody,
} from '../src/drive/driveClient';
import { DEFAULT_SETTINGS, type TriSyncSettings } from '../src/types';

function makeJsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): HttpResponseData {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    status,
    headers,
    text,
    json: body,
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('Google Drive multipart/related, resumable uploads, OAuth & Setup Bundle', () => {
  it('constructs valid binary multipart/related with exact ArrayBuffer slice, UTF-8 byte lengths, random boundary, and zero forbidden headers', () => {
    // Non-ASCII UTF-8 filename (emojis + CJK + accents) where string.length !== byteLength
    const metadata = {
      name: '日本語_🚀_Café.png',
      parents: ['root-folder-1'],
      appProperties: { parentMd5: 'abc123', writer: 'dev-mac' },
    };

    // Binary payload with NUL bytes, CRLF, high bytes, and fake boundary-like dashes
    const binary = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x01, 0xff, 0xfe, 0x2d, 0x2d, 0x0d, 0x0a,
      0xde, 0xad, 0xbe, 0xef,
    ]);

    const res1 = buildMultipartRelatedBody(metadata, binary, 'image/png');
    const res2 = buildMultipartRelatedBody(metadata, binary, 'image/png');

    // Random 24-byte hex boundary differs between calls
    expect(res1.boundary).not.toBe(res2.boundary);
    expect(res1.boundary).toMatch(/^trisync_[0-9a-f]{48}$/);
    expect(res1.contentTypeHeader).toBe(`multipart/related; boundary=${res1.boundary}`);

    // Exact ArrayBuffer slice (no trailing pooled garbage)
    const raw = new Uint8Array(res1.body);
    expect(res1.body.byteLength).toBe(raw.byteLength);

    // Parse multipart sections back from raw bytes
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const sep1 = enc.encode(`--${res1.boundary}\r\n`);
    const sep2 = enc.encode(`\r\n--${res1.boundary}\r\n`);
    const sepEnd = enc.encode(`\r\n--${res1.boundary}--\r\n`);
    const headerEnd = enc.encode('\r\n\r\n');

    expect(indexOfSubarray(raw, sep1, 0)).toBe(0);

    const p1HeaderStart = sep1.length;
    const p1HeaderEnd = indexOfSubarray(raw, headerEnd, p1HeaderStart);
    expect(p1HeaderEnd).toBeGreaterThan(p1HeaderStart);
    const p1Headers = dec.decode(raw.subarray(p1HeaderStart, p1HeaderEnd));
    expect(p1Headers).toBe('Content-Type: application/json; charset=UTF-8');
    expect(p1Headers).not.toContain('Content-Disposition');
    expect(p1Headers).not.toContain('Content-Transfer-Encoding');
    expect(p1Headers).not.toContain('Content-Length');

    const p1BodyStart = p1HeaderEnd + headerEnd.length;
    const p2SepIdx = indexOfSubarray(raw, sep2, p1BodyStart);
    expect(p2SepIdx).toBeGreaterThan(p1BodyStart);
    const parsedMeta = JSON.parse(dec.decode(raw.subarray(p1BodyStart, p2SepIdx)));
    expect(parsedMeta).toEqual(metadata);

    const p2HeaderStart = p2SepIdx + sep2.length;
    const p2HeaderEnd = indexOfSubarray(raw, headerEnd, p2HeaderStart);
    expect(p2HeaderEnd).toBeGreaterThan(p2HeaderStart);
    const p2Headers = dec.decode(raw.subarray(p2HeaderStart, p2HeaderEnd));
    expect(p2Headers).toBe('Content-Type: image/png');
    expect(p2Headers).not.toContain('Content-Disposition');
    expect(p2Headers).not.toContain('Content-Transfer-Encoding');
    expect(p2Headers).not.toContain('Content-Length');

    const p2BodyStart = p2HeaderEnd + headerEnd.length;
    const endIdx = indexOfSubarray(raw, sepEnd, p2BodyStart);
    expect(endIdx).toBe(raw.byteLength - sepEnd.length);

    // Byte-for-byte binary round-trip equality!
    const extractedBinary = raw.subarray(p2BodyStart, endIdx);
    expect(Array.from(extractedBinary)).toEqual(Array.from(binary));
  });

  it('uses 2-step uploadType=resumable with Content-Range chunking for files > 4.5 MB', async () => {
    const calls: HttpRequestParams[] = [];
    const receivedChunks: Uint8Array[] = [];
    const totalSize = 5 * 1024 * 1024 + 123; // > 4.5 MB -> 2 chunks of 4 MB + remaining
    const payload = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) {
      payload[i] = (i * 17) & 0xff;
    }

    const mockHttp: HttpRequestFn = async (params) => {
      calls.push(params);
      // Verify NO forbidden Content-Length header is ever sent
      for (const h of Object.keys(params.headers ?? {})) {
        expect(h.toLowerCase()).not.toBe('content-length');
      }

      if (params.url.includes('uploadType=resumable')) {
        expect(params.method).toBe('POST');
        expect(params.headers?.['X-Upload-Content-Length']).toBe(String(totalSize));
        return makeJsonResponse(200, {}, { Location: 'https://upload.example/session-1' });
      }

      if (params.url === 'https://upload.example/session-1') {
        expect(params.method).toBe('PUT');
        const chunk = new Uint8Array(params.body as ArrayBuffer);
        receivedChunks.push(chunk);
        const cr = params.headers?.['Content-Range'] ?? '';
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
        expect(match).not.toBeNull();
        const end = Number(match![2]);
        const total = Number(match![3]);
        if (end + 1 < total) {
          return makeJsonResponse(308, {}, { Range: `bytes=0-${end}` });
        }
        return makeJsonResponse(200, {
          id: 'large-file-1',
          name: 'video.bin',
          mimeType: 'application/octet-stream',
          size: String(totalSize),
        });
      }

      throw new Error(`Unexpected URL: ${params.url}`);
    };

    const auth = new GoogleAuthManager({
      tokens: {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rtok',
        accessToken: 'valid-token',
        tokenExpiresAt: Date.now() + 3_600_000,
      },
      httpRequest: mockHttp,
      isDesktop: false,
    });

    const drive = new GoogleDriveClient({ auth, httpRequest: mockHttp });
    const meta = await drive.createFile({
      name: 'video.bin',
      parentId: 'folder-1',
      mimeType: 'application/octet-stream',
      content: payload,
    });

    expect(meta.id).toBe('large-file-1');
    expect(calls.length).toBe(3); // 1 init POST + 2 chunk PUTs
    expect(receivedChunks.length).toBe(2);

    // Reconstruct uploaded binary and verify byte-for-byte equality
    const reconstructed = new Uint8Array(totalSize);
    let offset = 0;
    for (const c of receivedChunks) {
      reconstructed.set(c, offset);
      offset += c.byteLength;
    }
    expect(offset).toBe(totalSize);
    expect(reconstructed[0]).toBe(payload[0]);
    expect(reconstructed[4 * 1024 * 1024]).toBe(payload[4 * 1024 * 1024]);
    expect(reconstructed[totalSize - 1]).toBe(payload[totalSize - 1]);
  });

  it('deduplicates concurrent 401 token refreshes (single-flight) and preserves refreshToken', async () => {
    let refreshPostCount = 0;
    let driveCallCount = 0;

    const mockHttp: HttpRequestFn = async (params) => {
      if (params.url.includes('oauth2.googleapis.com/token')) {
        refreshPostCount++;
        // Verify client_secret is included alongside refresh_token
        expect(String(params.body)).toContain('client_secret=my-secret');
        expect(String(params.body)).toContain('refresh_token=persistent-refresh-token');
        await new Promise((r) => setTimeout(r, 25));
        // Google omits refresh_token in refresh response!
        return makeJsonResponse(200, {
          access_token: 'fresh-access-token',
          expires_in: 3600,
        });
      }

      driveCallCount++;
      if (params.headers?.Authorization === 'Bearer stale-token') {
        return makeJsonResponse(401, { error: { code: 401, message: 'Unauthorized' } });
      }
      expect(params.headers?.Authorization).toBe('Bearer fresh-access-token');
      expect(params.url).toContain('fields=');
      return makeJsonResponse(200, { id: 'f1', name: 'Note.md', mimeType: 'text/markdown' });
    };

    const auth = new GoogleAuthManager({
      tokens: {
        clientId: 'my-client-id',
        clientSecret: 'my-secret',
        refreshToken: 'persistent-refresh-token',
        accessToken: 'stale-token',
        tokenExpiresAt: Date.now() + 3_600_000,
      },
      httpRequest: mockHttp,
      isDesktop: false,
    });

    const drive = new GoogleDriveClient({ auth, httpRequest: mockHttp });

    // Fire 10 concurrent Drive calls all hitting 401 simultaneously
    const results = await Promise.all(
      Array.from({ length: 10 }, () => drive.getFileMetadata('f1'))
    );

    expect(results.every((r) => r?.id === 'f1')).toBe(true);
    expect(refreshPostCount).toBe(1); // Strictly single-flight!
    expect(driveCallCount).toBe(20); // 10 initial 401s + 10 retried 200s
    expect(auth.getTokenState().refreshToken).toBe('persistent-refresh-token');
    expect(auth.getTokenState().accessToken).toBe('fresh-access-token');
  });

  it('trips circuit breaker on 400 invalid_grant and stops retrying', async () => {
    let tokenCalls = 0;
    let breakerReason = '';

    const mockHttp: HttpRequestFn = async () => {
      tokenCalls++;
      return makeJsonResponse(400, {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      });
    };

    const auth = new GoogleAuthManager({
      tokens: {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'expired-rt',
        accessToken: '',
        tokenExpiresAt: 0,
      },
      httpRequest: mockHttp,
      isDesktop: false,
      onAuthCircuitTripped: (r) => {
        breakerReason = r;
      },
    });

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthCircuitOpenError);
    expect(auth.isCircuitOpen()).toBe(true);
    expect(breakerReason).toContain('invalid_grant');
    expect(tokenCalls).toBe(1);

    // Subsequent calls immediately throw AuthCircuitOpenError with ZERO additional HTTP calls
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthCircuitOpenError);
    await expect(auth.refreshAccessToken()).rejects.toBeInstanceOf(AuthCircuitOpenError);
    expect(tokenCalls).toBe(1);
  });

  it('round-trips PIN-encrypted Setup Bundle with vaultRootFolderId while regenerating deviceId', async () => {
    const macSettings: TriSyncSettings = {
      ...DEFAULT_SETTINGS,
      deviceId: 'mac-original-device-uuid',
      deviceName: 'MacBook',
      vaultId: 'shared-vault-123',
      vaultName: 'PersonalVault',
      vaultRootFolderId: 'drive-root-folder-999',
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      googleRefreshToken: 'google-refresh-token',
      firebaseConfig: {
        apiKey: 'fb-api-key',
        projectId: 'fb-project',
        appId: 'fb-app-id',
      },
      firebaseEmail: 'me@example.com',
      firebasePassword: 'super-secret-password',
    };

    const bundle = await exportEncryptedSetupBundle(macSettings, '948271');
    expect(bundle.startsWith('TRISYNC1:')).toBe(true);
    // Secrets must NOT appear in plaintext inside clipboard bundle
    expect(bundle).not.toContain('google-refresh-token');
    expect(bundle).not.toContain('super-secret-password');
    expect(bundle).not.toContain('mac-original-device-uuid');

    // Wrong PIN fails decryption
    await expect(importEncryptedSetupBundle(bundle, '000000')).rejects.toThrow(
      /wrong PIN|corrupted/i
    );

    // Correct PIN decrypts shared config and generates a brand-new unique deviceId!
    const imported1 = await importEncryptedSetupBundle(bundle, '948271');
    const imported2 = await importEncryptedSetupBundle(bundle, '948271');

    expect(imported1.payload.vaultRootFolderId).toBe('drive-root-folder-999');
    expect(imported1.payload.googleClientSecret).toBe('google-client-secret');
    expect(imported1.payload.googleRefreshToken).toBe('google-refresh-token');
    expect(imported1.payload.firebaseConfig?.projectId).toBe('fb-project');

    expect(imported1.newDeviceId).toBeTruthy();
    expect(imported1.newDeviceId).not.toBe('mac-original-device-uuid');
    expect(imported2.newDeviceId).not.toBe(imported1.newDeviceId);
    expect((imported1.payload as unknown as Record<string, unknown>).deviceId).toBeUndefined();
  });

  it('handles 0-byte uploadResumable cleanly via Content-Range: bytes */0', async () => {
    const calls: HttpRequestParams[] = [];

    const mockHttp: HttpRequestFn = async (params) => {
      calls.push(params);
      if (params.url.includes('uploadType=resumable')) {
        expect(params.headers?.['X-Upload-Content-Length']).toBe('0');
        return makeJsonResponse(200, {}, { Location: 'https://upload.example/empty-session' });
      }
      if (params.url === 'https://upload.example/empty-session') {
        expect(params.method).toBe('PUT');
        expect(params.headers?.['Content-Range']).toBe('bytes */0');
        expect((params.body as ArrayBuffer).byteLength).toBe(0);
        return makeJsonResponse(200, {
          id: 'empty-file-1',
          name: 'empty.md',
          mimeType: 'text/markdown',
          size: '0',
        });
      }
      throw new Error(`Unexpected URL: ${params.url}`);
    };

    const auth = new GoogleAuthManager({
      tokens: {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rtok',
        accessToken: 'valid-token',
        tokenExpiresAt: Date.now() + 3_600_000,
      },
      httpRequest: mockHttp,
      isDesktop: false,
    });

    // Force resumable path even for 0-byte payload
    const drive = new GoogleDriveClient({
      auth,
      httpRequest: mockHttp,
      multipartLimitBytes: -1,
    });

    const meta = await drive.createFile({
      name: 'empty.md',
      parentId: 'root-1',
      mimeType: 'text/markdown',
      content: new Uint8Array(0),
    });

    expect(meta.id).toBe('empty-file-1');
    expect(calls.length).toBe(2);
  });

  it('finds existing non-trashed folder by name and parentId with explicit fields', async () => {
    const mockHttp: HttpRequestFn = async (params) => {
      expect(params.url).toContain('fields=');
      expect(params.url).toContain('trashed%20%3D%20false');
      return makeJsonResponse(200, {
        files: [
          {
            id: 'existing-folder-42',
            name: 'Projects',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root-1'],
            trashed: false,
          },
        ],
      });
    };

    const auth = new GoogleAuthManager({
      tokens: {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rtok',
        accessToken: 'valid-token',
        tokenExpiresAt: Date.now() + 3_600_000,
      },
      httpRequest: mockHttp,
      isDesktop: false,
    });

    const drive = new GoogleDriveClient({ auth, httpRequest: mockHttp });
    const found = await drive.findFolderByName('Projects', 'root-1');
    expect(found?.id).toBe('existing-folder-42');
  });
});
