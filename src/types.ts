export interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export interface TriSyncSettings {
  deviceId: string;
  deviceName: string;
  vaultId: string;
  vaultName: string;
  vaultRootFolderId: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  googleAccessToken: string;
  googleTokenExpiresAt: number;
  firebaseConfig: FirebaseWebConfig | null;
  firebaseEmail: string;
  firebasePassword: string;
  forceLongPolling: boolean;
  debounceMs: number;
  maxAttachmentSizeMB: number;
  ignorePatterns: string[];
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  debugLogging: boolean;
}

export const DEFAULT_IGNORE_PATTERNS = [
  '.obsidian/**',
  '.trash/**',
  '**/.DS_Store',
  '**/Thumbs.db',
];

export const DEFAULT_SETTINGS: TriSyncSettings = {
  deviceId: '',
  deviceName: 'My Device',
  vaultId: '',
  vaultName: 'ObsidianVault',
  vaultRootFolderId: '',
  googleClientId: '',
  googleClientSecret: '',
  googleRefreshToken: '',
  googleAccessToken: '',
  googleTokenExpiresAt: 0,
  firebaseConfig: null,
  firebaseEmail: '',
  firebasePassword: '',
  forceLongPolling: false,
  debounceMs: 800,
  maxAttachmentSizeMB: 50,
  ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
  autoSyncEnabled: true,
  syncIntervalMinutes: 5,
  debugLogging: false,
};

export interface FileIndexEntry {
  driveId: string;
  md5: string;
  mtime: number;
  size: number;
  isText: boolean;
  prevMd5?: string;
  createdTime?: string;
  modifiedTime?: string;
}

export type PendingOpKind = 'upsert' | 'delete' | 'rename' | 'folder-rename';

export interface PendingOperation {
  id: string;
  kind: PendingOpKind;
  path: string;
  oldPath?: string;
  driveId?: string;
  baseMd5?: string;
  createdAt: number;
}

export interface DirtyRenameRecord {
  oldPath: string;
  newPath: string;
  driveId: string;
  isFolder: boolean;
  startedAt: number;
}

export interface SyncIndex {
  version: number;
  startPageToken: string | null;
  vaultRootFolderId: string | null;
  folderMap: Record<string, string>;
  files: Record<string, FileIndexEntry>;
  pendingOps: PendingOperation[];
  dirtyRenames: DirtyRenameRecord[];
  lastSeenSignalSeq: number;
  lastSeenPulseId?: string;
}

export function createEmptySyncIndex(vaultRootFolderId: string | null = null): SyncIndex {
  return {
    version: 1,
    startPageToken: null,
    vaultRootFolderId,
    folderMap: vaultRootFolderId ? { '': vaultRootFolderId } : {},
    files: {},
    pendingOps: [],
    dirtyRenames: [],
    lastSeenSignalSeq: 0,
    lastSeenPulseId: undefined,
  };
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFileMetadata;
}

export interface DriveChangesPage {
  changes: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface SignalEntry {
  seq: number;
  id: string;
  path: string;
  md5?: string;
  parentMd5?: string;
  trashed?: boolean;
  isFolder?: boolean;
  oldPath?: string;
}

export interface SignalDocument {
  seq: number;
  pulseId?: string;
  sender: string;
  updatedAt: number;
  requiresDeltaSync?: boolean;
  entries: SignalEntry[];
}

export type SyncStatusState =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'auth-error'
  | 'paused';

export interface SyncActivityEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'conflict';
  action: string;
  path?: string;
  detail: string;
  durationMs?: number;
}

export interface ConflictRecord {
  timestamp: number;
  canonicalPath: string;
  conflictPath: string;
  reason: string;
}

export interface SetupBundlePayload {
  vaultId: string;
  vaultName: string;
  vaultRootFolderId: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  firebaseConfig: FirebaseWebConfig | null;
  firebaseEmail: string;
  firebasePassword: string;
  ignorePatterns: string[];
  maxAttachmentSizeMB: number;
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const ROOT_SYNC_PARENT_NAME = 'ObsidianSync';
