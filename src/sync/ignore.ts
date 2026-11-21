/**
 * Cross-platform path normalization (Unicode NFC), case-folding for APFS,
 * Android-safe filename sanitization, and glob-based ignore matching.
 */

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.canvas',
  '.txt',
  '.json',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.svg',
  '.tex',
  '.bib',
  '.org',
  '.ini',
  '.toml',
  '.conf',
  '.sh',
  '.py',
]);

const JSON_EXTENSIONS = new Set(['.canvas', '.json']);

// Android/Windows forbidden path characters: : * ? " < > | \ / and ASCII control chars
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FILENAME_CHARS = /[:*?"<>|\\/\\\x00-\x1f]/g;

/**
 * Normalizes a vault-relative path to forward slashes, NFC Unicode,
 * with no leading/trailing slashes or duplicate separators.
 */
export function normalizePath(rawPath: string): string {
  const unified = rawPath
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return unified;
}

/**
 * Case-folded NFC path for APFS (macOS/iOS) case-insensitive comparison.
 */
export function foldPath(rawPath: string): string {
  return normalizePath(rawPath).toLowerCase();
}

export function dirname(rawPath: string): string {
  const p = normalizePath(rawPath);
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

export function basename(rawPath: string): string {
  const p = normalizePath(rawPath);
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((p) => p.length > 0).join('/'));
}

export function splitExt(fileName: string): { stem: string; ext: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) {
    return { stem: fileName, ext: '' };
  }
  return {
    stem: fileName.slice(0, dot),
    ext: fileName.slice(dot),
  };
}

export function isTextSyncPath(rawPath: string): boolean {
  const { ext } = splitExt(basename(rawPath));
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

export function isJsonPath(rawPath: string): boolean {
  const { ext } = splitExt(basename(rawPath));
  return JSON_EXTENSIONS.has(ext.toLowerCase());
}

export function guessMimeType(rawPath: string): string {
  const { ext } = splitExt(basename(rawPath));
  switch (ext.toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.canvas':
    case '.json':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    case '.css':
      return 'text/css';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.mp4':
      return 'video/mp4';
    default:
      return isTextSyncPath(rawPath) ? 'text/plain' : 'application/octet-stream';
  }
}

/**
 * Sanitizes a single filename segment so it is strictly safe on Android,
 * iOS, macOS, and Windows (ZERO `: * ? " < > | \ /` characters).
 */
export function sanitizePathSegment(raw: string, fallback = 'device'): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(FORBIDDEN_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Formats timestamp as Android-safe `YYYY-MM-DD HHmmss` (ZERO colons).
 */
export function formatConflictTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}-${m}-${d} ${hh}${mm}${ss}`;
}

/**
 * Builds an Android/iOS/macOS-safe conflict copy path:
 * `<dir>/<Name> (conflict <SafeDevice> YYYY-MM-DD HHmmss)<ext>`
 */
export function buildConflictPath(
  originalPath: string,
  deviceName: string,
  date: Date = new Date()
): string {
  const norm = normalizePath(originalPath);
  const dir = dirname(norm);
  const base = basename(norm);
  const { stem, ext } = splitExt(base);
  const safeDevice = sanitizePathSegment(deviceName, 'Device');
  const ts = formatConflictTimestamp(date);
  const safeStem = sanitizePathSegment(stem, 'Untitled');
  const safeExt = ext ? '.' + sanitizePathSegment(ext.slice(1), 'bin') : '';
  const fileName = `${safeStem} (conflict ${safeDevice} ${ts})${safeExt}`;
  return dir ? `${dir}/${fileName}` : fileName;
}

/**
 * Builds a deterministic case-collision disambiguation path for APFS:
 * `<dir>/<Name> (case-conflict <shortId>)<ext>`
 */
export function buildCaseConflictPath(originalPath: string, driveId: string): string {
  const norm = normalizePath(originalPath);
  const dir = dirname(norm);
  const base = basename(norm);
  const { stem, ext } = splitExt(base);
  const shortId = sanitizePathSegment(driveId.slice(0, 6), 'id');
  const safeStem = sanitizePathSegment(stem, 'Untitled');
  const safeExt = ext ? '.' + sanitizePathSegment(ext.slice(1), 'bin') : '';
  const fileName = `${safeStem} (case-conflict ${shortId})${safeExt}`;
  return dir ? `${dir}/${fileName}` : fileName;
}

export function isConflictPath(rawPath: string): boolean {
  const name = basename(rawPath);
  return /\(conflict [^)]+\)/.test(name) || /\(case-conflict [^)]+\)/.test(name);
}

/**
 * Compiles a glob pattern into a RegExp matching NFC-normalized relative paths.
 * Supports `**` (any depth including zero segments), `*` (single segment), `?` (single non-slash char).
 */
function globToRegExp(rawPattern: string): RegExp {
  const pattern = normalizePath(rawPattern.trim());
  let regexStr = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` matches zero or more directories
          regexStr += '(?:.*/)?';
          i += 3;
          continue;
        }
        // trailing `**` or `**foo`
        regexStr += '.*';
        i += 2;
        continue;
      }
      regexStr += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    }
    // Escape regex special characters
    regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export class IgnoreMatcher {
  private readonly matchers: Array<{ raw: string; regex: RegExp; dirPrefix?: string }> = [];

  constructor(patterns: readonly string[]) {
    for (const raw of patterns) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const norm = normalizePath(trimmed);
      if (!norm) continue;

      const entry: { raw: string; regex: RegExp; dirPrefix?: string } = {
        raw: norm,
        regex: globToRegExp(norm),
      };

      // If pattern is `foo/**`, also match the directory `foo` itself
      if (norm.endsWith('/**')) {
        entry.dirPrefix = norm.slice(0, -3);
      }

      this.matchers.push(entry);
    }
  }

  isIgnored(rawPath: string): boolean {
    const norm = normalizePath(rawPath);
    if (!norm) return false;

    for (const m of this.matchers) {
      if (m.dirPrefix !== undefined && (norm === m.dirPrefix || norm.startsWith(m.dirPrefix + '/'))) {
        return true;
      }
      if (m.regex.test(norm)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Helper to look up a path in a map with exact NFC match first, then case-folded fallback.
 */
export function findInPathMap<T>(
  map: Record<string, T>,
  rawPath: string,
  caseInsensitive: boolean
): { key: string; value: T } | null {
  const nfc = normalizePath(rawPath);
  if (Object.prototype.hasOwnProperty.call(map, nfc)) {
    return { key: nfc, value: map[nfc] };
  }
  if (caseInsensitive) {
    const folded = foldPath(nfc);
    for (const key of Object.keys(map)) {
      if (foldPath(key) === folded) {
        return { key, value: map[key] };
      }
    }
  }
  return null;
}
