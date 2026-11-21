import type {
  DriveChangesPage,
  DriveFileMetadata,
} from '../types';
import {
  DRIVE_FOLDER_MIME,
  ROOT_SYNC_PARENT_NAME,
} from '../types';
import type { GoogleAuthManager, HttpRequestFn, HttpResponseData } from '../auth/googleAuth';
import { withRetry } from '../utils/concurrency';

/**
 * Google Drive API v3 client built strictly over Obsidian's `requestUrl` abstraction.
 *
 * Safeguards implemented:
 * - Manual `Uint8Array` `multipart/related` framing with exact `ArrayBuffer` slice,
 *   strict `Content-Type`-only headers, random 24-byte hex boundary, UTF-8 byte lengths,
 *   and ZERO forbidden `Content-Length` / `Content-Disposition` / `Content-Transfer-Encoding`.
 * - `<= 4.5 MB` uploads use `uploadType=multipart` (atomically writing `appProperties`).
 * - `> 4.5 MB` uploads use 2-step `uploadType=resumable` (4 MB chunks with `Content-Range`).
 * - Explicit `?fields=...` on EVERY Drive API call.
 * - Single-query paginated initial inventory `files.list(q="trashed = false", pageSize=1000)`.
 * - Automatic single-flight `401` token refresh + retry with exponential backoff on `429`/`5xx`.
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export const MULTIPART_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024); // 4.5 MB
export const RESUMABLE_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB (multiple of 256 KiB)

export const FILE_FIELDS =
  'id,name,mimeType,parents,md5Checksum,size,trashed,createdTime,modifiedTime,appProperties';
export const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
export const CHANGES_FIELDS = `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`;

export interface CreateFileParams {
  name: string;
  parentId: string;
  mimeType: string;
  content: Uint8Array;
  appProperties?: Record<string, string>;
}

export interface UpdateFileContentParams {
  mimeType: string;
  content: Uint8Array;
  appProperties?: Record<string, string>;
  trashed?: boolean;
  name?: string;
}

export interface UpdateFileMetadataParams {
  name?: string;
  addParents?: string[];
  removeParents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export interface IRemoteDriveClient {
  ensureVaultRootFolder(vaultName: string, existingRootId?: string): Promise<string>;
  listAllItems(): Promise<DriveFileMetadata[]>;
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<DriveChangesPage>;
  getFileMetadata(fileId: string): Promise<DriveFileMetadata | null>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  findFolderByName(name: string, parentId: string): Promise<DriveFileMetadata | null>;
  createFolder(name: string, parentId: string): Promise<DriveFileMetadata>;
  createFile(params: CreateFileParams): Promise<DriveFileMetadata>;
  updateFileContent(fileId: string, params: UpdateFileContentParams): Promise<DriveFileMetadata>;
  updateFileMetadata(fileId: string, params: UpdateFileMetadataParams): Promise<DriveFileMetadata>;
  trashFile(fileId: string): Promise<DriveFileMetadata | null>;
}

export class DriveApiError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly nonRetryable: boolean;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.nonRetryable =
      status === 400 || status === 401 || status === 404 || status === 409;
  }
}

const utf8Encoder = new TextEncoder();

export function generateRandomBoundary(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `trisync_${hex}`;
}

/**
 * Manually constructs a Google Drive v3 `multipart/related` request body.
 * - Uses `\r\n` CRLF strictly.
 * - Emits ONLY `Content-Type` headers inside each part (no `Content-Disposition`,
 *   no `Content-Transfer-Encoding`, no `Content-Length`).
 * - Measures UTF-8 byte lengths with `TextEncoder` (safe for emojis/CJK/non-ASCII names).
 * - Returns an exact-length `ArrayBuffer` slice safe for Obsidian's `requestUrl`.
 */
export function buildMultipartRelatedBody(
  metadata: Record<string, unknown>,
  content: Uint8Array,
  contentType: string,
  boundary: string = generateRandomBoundary()
): { body: ArrayBuffer; contentTypeHeader: string; boundary: string } {
  const metaJson = JSON.stringify(metadata);
  const part1Header = utf8Encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
  );
  const part1Body = utf8Encoder.encode(metaJson);
  const part2Header = utf8Encoder.encode(
    `\r\n--${boundary}\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`
  );
  const closing = utf8Encoder.encode(`\r\n--${boundary}--\r\n`);

  const totalLength =
    part1Header.byteLength +
    part1Body.byteLength +
    part2Header.byteLength +
    content.byteLength +
    closing.byteLength;

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  combined.set(part1Header, offset);
  offset += part1Header.byteLength;
  combined.set(part1Body, offset);
  offset += part1Body.byteLength;
  combined.set(part2Header, offset);
  offset += part2Header.byteLength;
  combined.set(content, offset);
  offset += content.byteLength;
  combined.set(closing, offset);

  // Exact ArrayBuffer slice matching byteOffset..byteOffset+byteLength
  const exactBuffer = combined.buffer.slice(
    combined.byteOffset,
    combined.byteOffset + combined.byteLength
  );

  return {
    body: exactBuffer,
    contentTypeHeader: `multipart/related; boundary=${boundary}`,
    boundary,
  };
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return undefined;
}

function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = getHeaderCaseInsensitive(headers, 'retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (!Number.isNaN(secs) && secs >= 0) {
    return secs * 1000;
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function parseJsonResponse<T>(res: HttpResponseData): T {
  if (res.json !== undefined && res.json !== null) {
    return res.json as T;
  }
  return JSON.parse(res.text) as T;
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class GoogleDriveClient implements IRemoteDriveClient {
  private readonly auth: GoogleAuthManager;
  private readonly httpRequest: HttpRequestFn;
  private readonly multipartLimitBytes: number;
  private readonly resumableChunkBytes: number;

  constructor(options: {
    auth: GoogleAuthManager;
    httpRequest: HttpRequestFn;
    multipartLimitBytes?: number;
    resumableChunkBytes?: number;
  }) {
    this.auth = options.auth;
    this.httpRequest = options.httpRequest;
    this.multipartLimitBytes = options.multipartLimitBytes ?? MULTIPART_LIMIT_BYTES;
    this.resumableChunkBytes = options.resumableChunkBytes ?? RESUMABLE_CHUNK_BYTES;
  }

  private async requestWithAuth(params: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    acceptStatuses?: number[];
  }): Promise<HttpResponseData> {
    const acceptStatuses = params.acceptStatuses ?? [];

    return withRetry(async () => {
      let token = await this.auth.getAccessToken(false);
      let res = await this.sendAuthorized(params, token);

      if (res.status === 401) {
        token = await this.auth.getAccessToken(true);
        res = await this.sendAuthorized(params, token);
      }

      if (
        (res.status >= 200 && res.status < 300) ||
        acceptStatuses.includes(res.status)
      ) {
        return res;
      }

      const retryAfterMs = parseRetryAfterMs(res.headers);
      throw new DriveApiError(
        `Google Drive API error (${res.status}) on ${params.method ?? 'GET'} ${params.url}: ${res.text.slice(0, 400)}`,
        res.status,
        retryAfterMs
      );
    });
  }

  private async sendAuthorized(
    params: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
    },
    accessToken: string
  ): Promise<HttpResponseData> {
    // Strip any forbidden Content-Length header defensively
    const cleanHeaders: Record<string, string> = {};
    if (params.headers) {
      for (const [k, v] of Object.entries(params.headers)) {
        if (k.toLowerCase() !== 'content-length') {
          cleanHeaders[k] = v;
        }
      }
    }
    cleanHeaders['Authorization'] = `Bearer ${accessToken}`;

    return this.httpRequest({
      url: params.url,
      method: params.method ?? 'GET',
      headers: cleanHeaders,
      body: params.body,
      throw: false,
    });
  }

  async ensureVaultRootFolder(
    vaultName: string,
    existingRootId?: string
  ): Promise<string> {
    if (existingRootId) {
      const meta = await this.getFileMetadata(existingRootId);
      if (meta && !meta.trashed && meta.mimeType === DRIVE_FOLDER_MIME) {
        return meta.id;
      }
    }

    // Find or create My Drive / ObsidianSync
    const parentQuery = `name = '${escapeDriveQueryLiteral(ROOT_SYNC_PARENT_NAME)}' and mimeType = '${DRIVE_FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const parentRes = await this.requestWithAuth({
      url: `${DRIVE_API_BASE}/files?q=${encodeURIComponent(parentQuery)}&pageSize=10&orderBy=createdTime&fields=${encodeURIComponent(LIST_FIELDS)}`,
    });
    const parentData = parseJsonResponse<{ files?: DriveFileMetadata[] }>(parentRes);
    let syncParentId = parentData.files?.[0]?.id;
    if (!syncParentId) {
      const createdParent = await this.createFolder(ROOT_SYNC_PARENT_NAME, 'root');
      syncParentId = createdParent.id;
    }

    // Find or create ObsidianSync / <vaultName>
    const vaultQuery = `name = '${escapeDriveQueryLiteral(vaultName)}' and mimeType = '${DRIVE_FOLDER_MIME}' and '${escapeDriveQueryLiteral(syncParentId)}' in parents and trashed = false`;
    const vaultRes = await this.requestWithAuth({
      url: `${DRIVE_API_BASE}/files?q=${encodeURIComponent(vaultQuery)}&pageSize=10&orderBy=createdTime&fields=${encodeURIComponent(LIST_FIELDS)}`,
    });
    const vaultData = parseJsonResponse<{ files?: DriveFileMetadata[] }>(vaultRes);
    if (vaultData.files && vaultData.files.length > 0) {
      return vaultData.files[0].id;
    }

    const createdVault = await this.createFolder(vaultName, syncParentId);
    return createdVault.id;
  }

  /**
   * Single-query paginated initial sync inventory (P1 #5):
   * Fetches all non-trashed plugin-visible items in ~1–3 requests instead of N per-folder queries.
   */
  async listAllItems(): Promise<DriveFileMetadata[]> {
    const items: DriveFileMetadata[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${DRIVE_API_BASE}/files`);
      url.searchParams.set('q', 'trashed = false');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('fields', LIST_FIELDS);
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const res = await this.requestWithAuth({ url: url.toString() });
      const data = parseJsonResponse<{
        files?: DriveFileMetadata[];
        nextPageToken?: string;
      }>(res);

      if (data.files) {
        items.push(...data.files);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return items;
  }

  async getStartPageToken(): Promise<string> {
    const res = await this.requestWithAuth({
      url: `${DRIVE_API_BASE}/changes/startPageToken?fields=startPageToken`,
    });
    const data = parseJsonResponse<{ startPageToken: string }>(res);
    return data.startPageToken;
  }

  async listChanges(pageToken: string): Promise<DriveChangesPage> {
    const url = new URL(`${DRIVE_API_BASE}/changes`);
    url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('includeRemoved', 'true');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', CHANGES_FIELDS);

    const res = await this.requestWithAuth({ url: url.toString() });
    const data = parseJsonResponse<{
      changes?: DriveChangesPage['changes'];
      nextPageToken?: string;
      newStartPageToken?: string;
    }>(res);

    return {
      changes: data.changes ?? [],
      nextPageToken: data.nextPageToken,
      newStartPageToken: data.newStartPageToken,
    };
  }

  async getFileMetadata(fileId: string): Promise<DriveFileMetadata | null> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`;
    const res = await this.requestWithAuth({
      url,
      acceptStatuses: [404],
    });
    if (res.status === 404) {
      return null;
    }
    return parseJsonResponse<DriveFileMetadata>(res);
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await this.requestWithAuth({ url });
    return new Uint8Array(res.arrayBuffer);
  }

  async findFolderByName(
    name: string,
    parentId: string
  ): Promise<DriveFileMetadata | null> {
    const query = `name = '${escapeDriveQueryLiteral(name)}' and mimeType = '${DRIVE_FOLDER_MIME}' and '${escapeDriveQueryLiteral(parentId)}' in parents and trashed = false`;
    const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&pageSize=1&orderBy=createdTime&fields=${encodeURIComponent(LIST_FIELDS)}`;
    const res = await this.requestWithAuth({ url });
    const data = parseJsonResponse<{ files?: DriveFileMetadata[] }>(res);
    return data.files?.[0] ?? null;
  }

  async createFolder(name: string, parentId: string): Promise<DriveFileMetadata> {
    const url = `${DRIVE_API_BASE}/files?fields=${encodeURIComponent(FILE_FIELDS)}`;
    const res = await this.requestWithAuth({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name,
        mimeType: DRIVE_FOLDER_MIME,
        parents: [parentId],
      }),
    });
    return parseJsonResponse<DriveFileMetadata>(res);
  }

  async createFile(params: CreateFileParams): Promise<DriveFileMetadata> {
    const metadata: Record<string, unknown> = {
      name: params.name,
      parents: [params.parentId],
      mimeType: params.mimeType,
    };
    if (params.appProperties) {
      metadata.appProperties = params.appProperties;
    }

    if (params.content.byteLength <= this.multipartLimitBytes) {
      const { body, contentTypeHeader } = buildMultipartRelatedBody(
        metadata,
        params.content,
        params.mimeType
      );
      const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;
      const res = await this.requestWithAuth({
        url,
        method: 'POST',
        headers: {
          'Content-Type': contentTypeHeader,
        },
        body,
      });
      return parseJsonResponse<DriveFileMetadata>(res);
    }

    return this.uploadResumable({
      method: 'POST',
      url: `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`,
      metadata,
      mimeType: params.mimeType,
      content: params.content,
    });
  }

  async updateFileContent(
    fileId: string,
    params: UpdateFileContentParams
  ): Promise<DriveFileMetadata> {
    const metadata: Record<string, unknown> = {};
    if (params.appProperties) metadata.appProperties = params.appProperties;
    if (typeof params.trashed === 'boolean') metadata.trashed = params.trashed;
    if (params.name) metadata.name = params.name;

    if (params.content.byteLength <= this.multipartLimitBytes) {
      const { body, contentTypeHeader } = buildMultipartRelatedBody(
        metadata,
        params.content,
        params.mimeType
      );
      const url = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;
      const res = await this.requestWithAuth({
        url,
        method: 'PATCH',
        headers: {
          'Content-Type': contentTypeHeader,
        },
        body,
      });
      return parseJsonResponse<DriveFileMetadata>(res);
    }

    return this.uploadResumable({
      method: 'PATCH',
      url: `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`,
      metadata,
      mimeType: params.mimeType,
      content: params.content,
    });
  }

  private async uploadResumable(params: {
    method: 'POST' | 'PATCH';
    url: string;
    metadata: Record<string, unknown>;
    mimeType: string;
    content: Uint8Array;
  }): Promise<DriveFileMetadata> {
    const totalBytes = params.content.byteLength;

    // Step 1: Initiate resumable upload session
    const initRes = await this.requestWithAuth({
      url: params.url,
      method: params.method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': params.mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(totalBytes),
      },
      body: JSON.stringify(params.metadata),
    });

    const uploadUrl = getHeaderCaseInsensitive(initRes.headers, 'location');
    if (!uploadUrl) {
      throw new DriveApiError(
        'Google Drive resumable upload initiation response missing Location header',
        500
      );
    }

    // Handle 0-byte resumable uploads cleanly (Content-Range: bytes */0)
    if (totalBytes === 0) {
      const emptyRes = await this.requestWithAuth({
        url: uploadUrl,
        method: 'PUT',
        headers: {
          'Content-Type': params.mimeType || 'application/octet-stream',
          'Content-Range': 'bytes */0',
        },
        body: new ArrayBuffer(0),
      });
      return parseJsonResponse<DriveFileMetadata>(emptyRes);
    }

    // Step 2: Upload binary chunks with Content-Range and exact ArrayBuffer slices
    let offset = 0;
    while (offset < totalBytes) {
      const end = Math.min(offset + this.resumableChunkBytes, totalBytes);
      const chunkCopy = new Uint8Array(params.content.subarray(offset, end));
      const exactChunkBuf: ArrayBuffer = chunkCopy.buffer;

      const chunkRes = await this.requestWithAuth({
        url: uploadUrl,
        method: 'PUT',
        headers: {
          'Content-Type': params.mimeType || 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end - 1}/${totalBytes}`,
        },
        body: exactChunkBuf,
        acceptStatuses: [308],
      });

      if (chunkRes.status === 200 || chunkRes.status === 201) {
        return parseJsonResponse<DriveFileMetadata>(chunkRes);
      }

      if (chunkRes.status === 308) {
        const rangeHeader = getHeaderCaseInsensitive(chunkRes.headers, 'range');
        if (rangeHeader) {
          const match = /bytes=0-(\d+)/.exec(rangeHeader);
          if (match) {
            offset = Number(match[1]) + 1;
            continue;
          }
        }
        offset = end;
        continue;
      }

      throw new DriveApiError(
        `Unexpected resumable chunk status ${chunkRes.status}`,
        chunkRes.status
      );
    }

    throw new DriveApiError('Resumable upload finished without receiving file metadata', 500);
  }

  async updateFileMetadata(
    fileId: string,
    params: UpdateFileMetadataParams
  ): Promise<DriveFileMetadata> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', FILE_FIELDS);
    if (params.addParents && params.addParents.length > 0) {
      url.searchParams.set('addParents', params.addParents.join(','));
    }
    if (params.removeParents && params.removeParents.length > 0) {
      url.searchParams.set('removeParents', params.removeParents.join(','));
    }

    const bodyObj: Record<string, unknown> = {};
    if (params.name !== undefined) bodyObj.name = params.name;
    if (params.trashed !== undefined) bodyObj.trashed = params.trashed;
    if (params.appProperties !== undefined) bodyObj.appProperties = params.appProperties;

    const res = await this.requestWithAuth({
      url: url.toString(),
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(bodyObj),
    });
    return parseJsonResponse<DriveFileMetadata>(res);
  }

  async trashFile(fileId: string): Promise<DriveFileMetadata | null> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`;
    const res = await this.requestWithAuth({
      url,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ trashed: true }),
      acceptStatuses: [404],
    });
    if (res.status === 404) {
      return null;
    }
    return parseJsonResponse<DriveFileMetadata>(res);
  }
}
