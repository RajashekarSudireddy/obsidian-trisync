import { md5Bytes, md5String } from '../crypto/md5';
import {
  DRIVE_FOLDER_MIME,
  createEmptySyncIndex,
  type ConflictRecord,
  type DirtyRenameRecord,
  type DriveChange,
  type DriveFileMetadata,
  type FileIndexEntry,
  type PendingOperation,
  type SignalDocument,
  type SyncActivityEntry,
  type SyncIndex,
  type SyncStatusState,
  type TriSyncSettings,
} from '../types';
import { AuthCircuitOpenError } from '../auth/googleAuth';
import type { IRemoteDriveClient } from '../drive/driveClient';
import type { ISignalBus, OutgoingSignalItem } from '../signal/firestoreSignal';
import { SIGNAL_RING_BUFFER_SIZE } from '../signal/firestoreSignal';
import {
  KeyedMutex,
  TaskPool,
  generateUuid,
} from '../utils/concurrency';
import { EchoSuppressor } from './echoSuppressor';
import {
  IgnoreMatcher,
  basename,
  buildCaseConflictPath,
  buildConflictPath,
  dirname,
  foldPath,
  guessMimeType,
  isJsonPath,
  isTextSyncPath,
  joinPath,
  normalizePath,
} from './ignore';
import { merge3 } from './merge3';
import type { IVaultAdapter } from './vaultStore';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const ACTIVE_EDITOR_DEFER_MS = 1500;
const MAX_ACTIVITY_LOG = 250;

export interface SyncEngineCallbacks {
  onStatusChange?: (status: SyncStatusState) => void;
  onActivity?: (entry: SyncActivityEntry) => void;
  onConflict?: (record: ConflictRecord) => void;
  onVaultRootFolderResolved?: (rootFolderId: string) => Promise<void> | void;
}

export interface SyncEngineOptions {
  settings: TriSyncSettings;
  vault: IVaultAdapter;
  drive: IRemoteDriveClient;
  signalBus?: ISignalBus | null;
  callbacks?: SyncEngineCallbacks;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  activeEditorDeferMs?: number;
}

/**
 * Deterministic canonical election for duplicate Drive files/folders:
 * Earliest `createdTime`, tie-broken by lexicographically smallest `id`.
 */
export function electCanonical<T extends { id: string; createdTime?: string }>(
  items: readonly T[]
): { winner: T; losers: T[] } {
  if (items.length === 0) {
    throw new Error('electCanonical requires at least one item');
  }
  const sorted = [...items].sort((a, b) => {
    const tA = a.createdTime ?? '9999-12-31T23:59:59.999Z';
    const tB = b.createdTime ?? '9999-12-31T23:59:59.999Z';
    if (tA < tB) return -1;
    if (tA > tB) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { winner: sorted[0], losers: sorted.slice(1) };
}

function isNetworkOrOfflineError(err: unknown): boolean {
  if (err instanceof AuthCircuitOpenError) return false;
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string; code?: string };
  if (typeof e.status === 'number') {
    return e.status === 0 || e.status === 429 || e.status >= 500;
  }
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('offline') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('fetch') ||
    msg.includes('socket') ||
    msg.includes('econn') ||
    msg.includes('enotfound')
  );
}

function isValidJsonString(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export class SyncEngine {
  private settings: TriSyncSettings;
  private readonly vault: IVaultAdapter;
  private readonly drive: IRemoteDriveClient;
  private signalBus: ISignalBus | null;
  private readonly callbacks: SyncEngineCallbacks;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly activeEditorDeferMs: number;

  private ignoreMatcher: IgnoreMatcher;
  private readonly echoSuppressor: EchoSuppressor;
  private readonly pathMutex = new KeyedMutex();
  private readonly taskPool = new TaskPool(6);
  private readonly folderCreationInFlight = new Map<string, Promise<string>>();

  private index!: SyncIndex;
  private initialized = false;
  private paused = false;
  private status: SyncStatusState = 'idle';
  private activeOps = 0;

  private signalUnsubscribe: (() => void) | null = null;
  private deltaSyncPromise: Promise<void> | null = null;
  private deltaSyncQueued = false;
  private reconcilePromise: Promise<void> | null = null;

  private readonly activityLog: SyncActivityEntry[] = [];
  private readonly conflicts: ConflictRecord[] = [];
  private lastSyncTime = 0;

  constructor(options: SyncEngineOptions) {
    this.settings = options.settings;
    this.vault = options.vault;
    this.drive = options.drive;
    this.signalBus = options.signalBus ?? null;
    this.callbacks = options.callbacks ?? {};
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.activeEditorDeferMs = options.activeEditorDeferMs ?? ACTIVE_EDITOR_DEFER_MS;
    this.ignoreMatcher = new IgnoreMatcher(options.settings.ignorePatterns);
    this.echoSuppressor = new EchoSuppressor(
      10_000,
      options.vault.caseInsensitive,
      this.now
    );
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.index = await this.vault.loadIndex();
    if (
      this.index.vaultRootFolderId &&
      this.settings.vaultRootFolderId &&
      this.index.vaultRootFolderId !== this.settings.vaultRootFolderId
    ) {
      // Root folder switched (e.g. Setup Bundle import / new Drive vault):
      // Reset stale index so next reconcile merges/uploads instead of trashing local vault!
      this.index = createEmptySyncIndex(this.settings.vaultRootFolderId);
      await this.vault.saveIndex(this.index);
    } else if (this.settings.vaultRootFolderId && !this.index.vaultRootFolderId) {
      this.index.vaultRootFolderId = this.settings.vaultRootFolderId;
      this.index.folderMap[''] = this.settings.vaultRootFolderId;
    } else if (this.index.vaultRootFolderId && !this.settings.vaultRootFolderId) {
      this.settings.vaultRootFolderId = this.index.vaultRootFolderId;
    }
    this.attachSignalBus(this.signalBus);
    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * Resets sync index cleanly when switching to a different `vaultRootFolderId`
   * (prevents Case 6 from trashing the local vault against stale index entries).
   */
  async resetForNewVaultRoot(newRootFolderId: string): Promise<void> {
    await this.ensureInitialized();
    const trimmed = newRootFolderId.trim();
    this.settings.vaultRootFolderId = trimmed;
    this.index = createEmptySyncIndex(trimmed || null);
    this.echoSuppressor.clear();
    await this.vault.saveIndex(this.index);
  }

  updateSettings(settings: TriSyncSettings): void {
    this.settings = settings;
    this.ignoreMatcher = new IgnoreMatcher(settings.ignorePatterns);
    if (this.initialized && settings.vaultRootFolderId) {
      if (
        this.index.vaultRootFolderId &&
        this.index.vaultRootFolderId !== settings.vaultRootFolderId
      ) {
        this.index = createEmptySyncIndex(settings.vaultRootFolderId);
        this.echoSuppressor.clear();
        void this.vault.saveIndex(this.index);
      } else {
        this.index.vaultRootFolderId = settings.vaultRootFolderId;
        this.index.folderMap[''] = settings.vaultRootFolderId;
      }
    }
  }

  attachSignalBus(signalBus: ISignalBus | null): void {
    if (this.signalUnsubscribe) {
      this.signalUnsubscribe();
      this.signalUnsubscribe = null;
    }
    this.signalBus = signalBus;
    if (signalBus) {
      this.signalUnsubscribe = signalBus.subscribe((doc) => {
        void this.handleIncomingSignal(doc);
      });
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.setStatus(paused ? 'paused' : 'idle');
  }

  isPaused(): boolean {
    return this.paused;
  }

  getStatus(): SyncStatusState {
    return this.status;
  }

  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  getActivityLog(): readonly SyncActivityEntry[] {
    return this.activityLog;
  }

  clearActivityLog(): void {
    this.activityLog.length = 0;
  }

  getConflicts(): readonly ConflictRecord[] {
    return this.conflicts;
  }

  getIndexSnapshot(): SyncIndex {
    return JSON.parse(JSON.stringify(this.index)) as SyncIndex;
  }

  getEchoSuppressor(): EchoSuppressor {
    return this.echoSuppressor;
  }

  dispose(): void {
    if (this.signalUnsubscribe) {
      this.signalUnsubscribe();
      this.signalUnsubscribe = null;
    }
    this.echoSuppressor.clear();
  }

  private setStatus(next: SyncStatusState): void {
    if (this.status === next) return;
    this.status = next;
    this.callbacks.onStatusChange?.(next);
  }

  private beginSyncOp(): void {
    this.activeOps++;
    if (!this.paused && this.status !== 'auth-error') {
      this.setStatus('syncing');
    }
  }

  private endSyncOp(hadError?: unknown): void {
    this.activeOps = Math.max(0, this.activeOps - 1);
    if (hadError instanceof AuthCircuitOpenError) {
      this.setStatus('auth-error');
      return;
    }
    if (hadError && isNetworkOrOfflineError(hadError)) {
      this.setStatus('offline');
      return;
    }
    if (this.activeOps === 0) {
      if (!hadError) {
        this.lastSyncTime = this.now();
      }
      if (!this.paused && this.status !== 'auth-error') {
        this.setStatus('idle');
      }
    }
  }

  private log(
    level: SyncActivityEntry['level'],
    action: string,
    detail: string,
    path?: string,
    durationMs?: number
  ): void {
    const entry: SyncActivityEntry = {
      timestamp: this.now(),
      level,
      action,
      path,
      detail,
      durationMs,
    };
    this.activityLog.unshift(entry);
    if (this.activityLog.length > MAX_ACTIVITY_LOG) {
      this.activityLog.length = MAX_ACTIVITY_LOG;
    }
    this.callbacks.onActivity?.(entry);
  }

  private recordConflict(canonicalPath: string, conflictPath: string, reason: string): void {
    const rec: ConflictRecord = {
      timestamp: this.now(),
      canonicalPath,
      conflictPath,
      reason,
    };
    this.conflicts.unshift(rec);
    if (this.conflicts.length > 100) {
      this.conflicts.length = 100;
    }
    this.log('conflict', 'conflict', `${reason} -> ${conflictPath}`, canonicalPath);
    this.callbacks.onConflict?.(rec);
  }

  private buildDriveIdToPathMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [p, entry] of Object.entries(this.index.files)) {
      map.set(entry.driveId, p);
    }
    return map;
  }

  private buildFolderIdToPathMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [p, id] of Object.entries(this.index.folderMap)) {
      map.set(id, p);
    }
    return map;
  }

  private findIndexEntryByPath(
    rawPath: string
  ): { path: string; entry: FileIndexEntry } | null {
    const norm = normalizePath(rawPath);
    if (Object.prototype.hasOwnProperty.call(this.index.files, norm)) {
      return { path: norm, entry: this.index.files[norm] };
    }
    if (this.vault.caseInsensitive) {
      const folded = foldPath(norm);
      for (const [p, entry] of Object.entries(this.index.files)) {
        if (foldPath(p) === folded) {
          return { path: p, entry };
        }
      }
    }
    return null;
  }

  private findCaseCollision(
    rawPath: string,
    incomingDriveId: string
  ): { existingPath: string; existingEntry: FileIndexEntry } | null {
    if (!this.vault.caseInsensitive) return null;
    const norm = normalizePath(rawPath);
    const folded = foldPath(norm);
    for (const [p, entry] of Object.entries(this.index.files)) {
      if (p !== norm && foldPath(p) === folded && entry.driveId !== incomingDriveId) {
        return { existingPath: p, existingEntry: entry };
      }
    }
    return null;
  }

  private async ensureRootFolder(): Promise<string> {
    const existingId =
      this.index.vaultRootFolderId || this.settings.vaultRootFolderId || undefined;
    if (existingId && this.index.folderMap[''] === existingId) {
      return existingId;
    }
    const resolved = await this.drive.ensureVaultRootFolder(
      this.settings.vaultName || 'ObsidianVault',
      existingId
    );
    this.index.vaultRootFolderId = resolved;
    this.index.folderMap[''] = resolved;
    if (this.settings.vaultRootFolderId !== resolved) {
      this.settings.vaultRootFolderId = resolved;
      await this.callbacks.onVaultRootFolderResolved?.(resolved);
    }
    return resolved;
  }

  private async ensureRemoteFolder(rawFolderPath: string): Promise<string> {
    const folderPath = normalizePath(rawFolderPath);
    if (!folderPath) {
      return this.ensureRootFolder();
    }
    const cached = this.index.folderMap[folderPath];
    if (cached) return cached;

    const inflight = this.folderCreationInFlight.get(folderPath);
    if (inflight) return inflight;

    const task = (async () => {
      const parentPath = dirname(folderPath);
      const parentId = await this.ensureRemoteFolder(parentPath);
      // Re-check cache after awaiting parent
      if (this.index.folderMap[folderPath]) {
        return this.index.folderMap[folderPath];
      }
      const name = basename(folderPath);
      // Reuse existing non-trashed folder under parentId before creating a new one
      const existingRemote = await this.drive.findFolderByName(name, parentId);
      if (existingRemote && !existingRemote.trashed) {
        this.index.folderMap[folderPath] = existingRemote.id;
        return existingRemote.id;
      }
      const created = await this.drive.createFolder(name, parentId);
      this.index.folderMap[folderPath] = created.id;
      return created.id;
    })().finally(() => {
      this.folderCreationInFlight.delete(folderPath);
    });

    this.folderCreationInFlight.set(folderPath, task);
    return task;
  }

  private async emitSignals(
    items: OutgoingSignalItem[],
    options: { requiresDeltaSync?: boolean; immediate?: boolean } = {}
  ): Promise<void> {
    if (!this.signalBus || !this.signalBus.isConnected()) return;
    if (items.length === 0 && !options.requiresDeltaSync) return;
    try {
      await this.signalBus.publishChanges(items, options);
    } catch (err) {
      this.log('warn', 'signal-publish', `Signal publish skipped: ${String(err)}`);
    }
  }

  private isOversized(byteLength: number): boolean {
    const maxBytes = (this.settings.maxAttachmentSizeMB || 50) * 1024 * 1024;
    return byteLength > maxBytes;
  }

  private enqueuePendingOp(op: Omit<PendingOperation, 'id' | 'createdAt'>): void {
    const normPath = normalizePath(op.path);
    // Deduplicate same-path pending ops cleanly
    this.index.pendingOps = this.index.pendingOps.filter(
      (existing) => !(existing.path === normPath && existing.kind === op.kind)
    );
    this.index.pendingOps.push({
      ...op,
      path: normPath,
      oldPath: op.oldPath ? normalizePath(op.oldPath) : undefined,
      id: generateUuid(),
      createdAt: this.now(),
    });
  }

  /**
   * Coalesces dirty rename records per `driveId` so chained offline renames (`A -> B -> C`)
   * keep a single record (`oldPath: A, newPath: C`) and net no-ops (`A -> B -> A`) cancel out.
   */
  private upsertDirtyRename(rec: DirtyRenameRecord): void {
    const existingIdx = this.index.dirtyRenames.findIndex(
      (r) => r.driveId === rec.driveId
    );
    if (existingIdx !== -1) {
      const existing = this.index.dirtyRenames[existingIdx];
      if (existing.oldPath === rec.newPath) {
        // Renamed back to original path -> net no-op
        this.index.dirtyRenames.splice(existingIdx, 1);
      } else {
        existing.newPath = rec.newPath;
      }
      return;
    }
    this.index.dirtyRenames.push(rec);
  }

  /**
   * Crash-safe recovery for any in-flight local renames persisted before an abrupt shutdown.
   */
  async recoverDirtyRenames(): Promise<void> {
    await this.ensureInitialized();
    if (this.index.dirtyRenames.length === 0) return;

    const remaining: DirtyRenameRecord[] = [];
    for (const rec of [...this.index.dirtyRenames]) {
      try {
        const meta = await this.drive.getFileMetadata(rec.driveId);
        if (!meta || meta.trashed) {
          // Remote already gone; clean up index
          continue;
        }
        const targetParentId = await this.ensureRemoteFolder(dirname(rec.newPath));
        const targetName = basename(rec.newPath);
        const currentParents = meta.parents ?? [];
        const needsParentMove = !currentParents.includes(targetParentId);
        const needsRename = meta.name !== targetName;

        if (needsParentMove || needsRename) {
          await this.drive.updateFileMetadata(rec.driveId, {
            name: needsRename ? targetName : undefined,
            addParents: needsParentMove ? [targetParentId] : undefined,
            removeParents:
              needsParentMove && currentParents.length > 0 ? currentParents : undefined,
          });
        }

        // Only remap index if it has NOT already been remapped (prevents double-remapping newly created files at oldPath!)
        if (rec.isFolder) {
          if (this.index.folderMap[rec.oldPath] === rec.driveId) {
            this.remapIndexFolderPrefix(rec.oldPath, rec.newPath, rec.driveId);
          } else {
            this.index.folderMap[rec.newPath] = rec.driveId;
          }
        } else {
          const entry = this.index.files[rec.oldPath];
          if (entry && entry.driveId === rec.driveId) {
            delete this.index.files[rec.oldPath];
            this.index.files[rec.newPath] = entry;
          }
        }
        await this.emitSignals([
          {
            id: rec.driveId,
            path: rec.newPath,
            oldPath: rec.oldPath,
            isFolder: rec.isFolder,
          },
        ]);
        this.log(
          'info',
          'recover-rename',
          `Recovered interrupted rename ${rec.oldPath} -> ${rec.newPath}`,
          rec.newPath
        );
      } catch (err) {
        if (isNetworkOrOfflineError(err)) {
          remaining.push(rec);
        } else {
          this.log('warn', 'recover-rename', `Skipped dirty rename ${rec.oldPath}: ${String(err)}`);
        }
      }
    }

    this.index.dirtyRenames = remaining;
    await this.vault.saveIndex(this.index);
  }

  private remapIndexFolderPrefix(
    oldFolderPath: string,
    newFolderPath: string,
    folderId: string
  ): void {
    const oldNorm = normalizePath(oldFolderPath);
    const newNorm = normalizePath(newFolderPath);
    const oldPrefix = oldNorm + '/';
    const newPrefix = newNorm + '/';

    // Remap folderMap
    const nextFolderMap: Record<string, string> = {};
    for (const [fPath, fId] of Object.entries(this.index.folderMap)) {
      if (fPath === oldNorm) {
        nextFolderMap[newNorm] = fId;
      } else if (fPath.startsWith(oldPrefix)) {
        nextFolderMap[newPrefix + fPath.slice(oldPrefix.length)] = fId;
      } else {
        nextFolderMap[fPath] = fId;
      }
    }
    nextFolderMap[newNorm] = folderId;
    this.index.folderMap = nextFolderMap;

    // Remap files (bases/<driveId>.txt remain 100% untouched!)
    const nextFiles: Record<string, FileIndexEntry> = {};
    for (const [fPath, entry] of Object.entries(this.index.files)) {
      if (fPath.startsWith(oldPrefix)) {
        nextFiles[newPrefix + fPath.slice(oldPrefix.length)] = entry;
      } else {
        nextFiles[fPath] = entry;
      }
    }
    this.index.files = nextFiles;
  }

  /**
   * Flushes queued offline mutations (upserts, deletes, renames) back to Google Drive.
   */
  async flushOfflineQueue(): Promise<void> {
    await this.ensureInitialized();
    await this.recoverDirtyRenames();
    if (this.index.pendingOps.length === 0) return;

    const ops = [...this.index.pendingOps];
    this.index.pendingOps = [];
    await this.vault.saveIndex(this.index);

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      try {
        if (op.kind === 'upsert') {
          if (await this.vault.exists(op.path)) {
            await this.handleLocalCreateOrModify(op.path);
          }
        } else if (op.kind === 'delete') {
          await this.executeRemoteTrashForLocalDelete(op.path, op.driveId, op.baseMd5);
        } else if (op.kind === 'rename' && op.oldPath) {
          await this.handleLocalRename(op.oldPath, op.path, false);
        } else if (op.kind === 'folder-rename' && op.oldPath) {
          await this.handleLocalRename(op.oldPath, op.path, true);
        }
      } catch (err) {
        if (isNetworkOrOfflineError(err)) {
          // Put current + remaining back in queue
          this.index.pendingOps.unshift(...ops.slice(i));
          await this.vault.saveIndex(this.index);
          throw err;
        }
        this.log('error', 'flush-queue', `Pending op ${op.kind} failed: ${String(err)}`, op.path);
      }
    }
  }

  /**
   * Called on app resume (`visibilitychange -> visible`, `window.online`, `window.focus`).
   */
  async onResume(): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();
    try {
      await this.flushOfflineQueue();
      await this.runDeltaSync();
    } catch (err) {
      if (!(err instanceof AuthCircuitOpenError)) {
        this.log('warn', 'resume-sync', `Resume sync deferred: ${String(err)}`);
      }
    }
  }

  /**
   * Handles local vault `create` or `modify` event.
   */
  async handleLocalCreateOrModify(rawPath: string): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();
    const path = normalizePath(rawPath);
    if (!path || this.ignoreMatcher.isIgnored(path)) return;

    await this.pathMutex.runExclusive(path, async () => {
      if (!(await this.vault.exists(path))) return;

      const bytes = await this.vault.readBinary(path);
      const localMd5 = md5Bytes(bytes);

      // Echo suppression (both explicit record and content-idempotency guard)
      if (this.echoSuppressor.consumeWrite(path, localMd5)) {
        return;
      }

      const existingMatch = this.findIndexEntryByPath(path);
      if (
        existingMatch &&
        existingMatch.path === path &&
        existingMatch.entry.md5 === localMd5
      ) {
        return;
      }

      if (this.isOversized(bytes.byteLength)) {
        this.log(
          'warn',
          'skip-large',
          `Skipped file exceeding ${this.settings.maxAttachmentSizeMB} MB limit`,
          path
        );
        return;
      }

      this.beginSyncOp();
      const started = this.now();
      let opErr: unknown;
      try {
        await this.uploadFileLocked(
          path,
          bytes,
          localMd5,
          existingMatch?.entry,
          existingMatch?.path
        );
        this.log('info', 'upload', `Uploaded (${bytes.byteLength} B)`, path, this.now() - started);
      } catch (err) {
        opErr = err;
        if (isNetworkOrOfflineError(err)) {
          this.enqueuePendingOp({ kind: 'upsert', path });
          await this.vault.saveIndex(this.index);
          this.log('warn', 'offline-queue', `Queued offline upload`, path);
        } else {
          this.log('error', 'upload', `Upload failed: ${String(err)}`, path);
          throw err;
        }
      } finally {
        this.endSyncOp(opErr);
      }
    });
  }

  /**
   * Uploads a local file with 2-layer optimistic concurrency:
   * - Layer 1: Pre-flight `getFileMetadata` check for divergence / trash / 404.
   * - Layer 2: `appProperties: { parentMd5, writer }` + `{ prevMd5, prevBase }` retention.
   */
  private async uploadFileLocked(
    path: string,
    localBytes: Uint8Array,
    localMd5: string,
    existingEntry?: FileIndexEntry,
    existingPath?: string
  ): Promise<OutgoingSignalItem | null> {
    const isText = isTextSyncPath(path);
    const mimeType = guessMimeType(path);
    const caseChanged = Boolean(existingPath && existingPath !== path);

    if (existingEntry) {
      // Layer 1: Pre-flight remote state check
      const remoteMeta = await this.drive.getFileMetadata(existingEntry.driveId);

      if (!remoteMeta) {
        // 404 permanently removed on Drive while local was edited -> Edit-Wins-Over-Delete (re-create!)
        const parentId = await this.ensureRemoteFolder(dirname(path));
        const created = await this.drive.createFile({
          name: basename(path),
          parentId,
          mimeType,
          content: localBytes,
          appProperties: {
            parentMd5: '',
            writer: this.settings.deviceId,
          },
        });
        await this.vault.deleteBase(existingEntry.driveId);
        await this.vault.deletePrevBase(existingEntry.driveId);
        if (isText) {
          await this.vault.writeBase(created.id, utf8Decoder.decode(localBytes));
        }
        if (caseChanged && existingPath) {
          delete this.index.files[existingPath];
        }
        this.index.files[path] = {
          driveId: created.id,
          md5: localMd5,
          mtime: this.now(),
          size: localBytes.byteLength,
          isText,
          createdTime: created.createdTime,
          modifiedTime: created.modifiedTime,
        };
        await this.vault.saveIndex(this.index);
        const sig: OutgoingSignalItem = {
          id: created.id,
          path,
          md5: localMd5,
          parentMd5: '',
        };
        await this.emitSignals([sig]);
        return sig;
      }

      if (remoteMeta.trashed) {
        // Remote was trashed while local was edited -> Edit-Wins-Over-Delete (untrash + update!)
        const updated = await this.drive.updateFileContent(existingEntry.driveId, {
          mimeType,
          content: localBytes,
          trashed: false,
          name: caseChanged ? basename(path) : undefined,
          appProperties: {
            parentMd5: existingEntry.md5,
            writer: this.settings.deviceId,
          },
        });
        if (isText) {
          await this.vault.writeBase(updated.id, utf8Decoder.decode(localBytes));
        }
        if (caseChanged && existingPath) {
          delete this.index.files[existingPath];
        }
        this.index.files[path] = {
          ...existingEntry,
          md5: localMd5,
          prevMd5: existingEntry.md5,
          mtime: this.now(),
          size: localBytes.byteLength,
          modifiedTime: updated.modifiedTime,
        };
        await this.vault.saveIndex(this.index);
        const sig: OutgoingSignalItem = {
          id: updated.id,
          path,
          md5: localMd5,
          parentMd5: existingEntry.md5,
        };
        await this.emitSignals([sig]);
        return sig;
      }

      if (remoteMeta.md5Checksum && remoteMeta.md5Checksum !== existingEntry.md5) {
        // Pre-flight detected remote divergence! Pull & 3-way merge BEFORE uploading.
        if (caseChanged && existingPath) {
          delete this.index.files[existingPath];
          this.index.files[path] = existingEntry;
        }
        const remoteBytes = await this.drive.downloadFile(remoteMeta.id);
        const baseText = isText ? await this.vault.readBase(existingEntry.driveId) : null;
        return this.resolveConflictOrMerge({
          path,
          driveId: remoteMeta.id,
          baseText,
          localBytes,
          remoteBytes,
          remoteMeta,
        });
      }

      // Layer 2: Save prevMd5 + prevBase before overwriting Drive so a TOCTOU sibling race is detectable!
      const prevMd5 = existingEntry.md5;
      if (isText) {
        const oldBase = await this.vault.readBase(existingEntry.driveId);
        if (oldBase !== null) {
          await this.vault.writePrevBase(existingEntry.driveId, oldBase);
        }
      }

      const updated = await this.drive.updateFileContent(existingEntry.driveId, {
        mimeType,
        content: localBytes,
        name: caseChanged ? basename(path) : undefined,
        appProperties: {
          parentMd5: prevMd5,
          writer: this.settings.deviceId,
        },
      });

      if (isText) {
        await this.vault.writeBase(existingEntry.driveId, utf8Decoder.decode(localBytes));
      }

      if (caseChanged && existingPath) {
        delete this.index.files[existingPath];
      }
      this.index.files[path] = {
        ...existingEntry,
        md5: localMd5,
        prevMd5,
        mtime: this.now(),
        size: localBytes.byteLength,
        modifiedTime: updated.modifiedTime,
      };
      await this.vault.saveIndex(this.index);

      const sig: OutgoingSignalItem = {
        id: updated.id,
        path,
        oldPath: caseChanged ? existingPath : undefined,
        md5: localMd5,
        parentMd5: prevMd5,
      };
      await this.emitSignals([sig]);
      return sig;
    }

    // New file creation
    const parentId = await this.ensureRemoteFolder(dirname(path));
    const created = await this.drive.createFile({
      name: basename(path),
      parentId,
      mimeType,
      content: localBytes,
      appProperties: {
        parentMd5: '',
        writer: this.settings.deviceId,
      },
    });

    if (isText) {
      await this.vault.writeBase(created.id, utf8Decoder.decode(localBytes));
    }

    this.index.files[path] = {
      driveId: created.id,
      md5: localMd5,
      mtime: this.now(),
      size: localBytes.byteLength,
      isText,
      createdTime: created.createdTime,
      modifiedTime: created.modifiedTime,
    };
    await this.vault.saveIndex(this.index);

    const sig: OutgoingSignalItem = {
      id: created.id,
      path,
      md5: localMd5,
      parentMd5: '',
    };
    await this.emitSignals([sig]);
    return sig;
  }

  /**
   * Handles local vault `delete` event.
   */
  async handleLocalDelete(rawPath: string): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();
    const path = normalizePath(rawPath);
    if (!path || this.ignoreMatcher.isIgnored(path)) return;

    if (this.echoSuppressor.consumeDelete(path)) {
      return;
    }

    await this.pathMutex.runExclusive(path, async () => {
      const match = this.findIndexEntryByPath(path);
      if (!match) return;

      this.beginSyncOp();
      let opErr: unknown;
      try {
        await this.executeRemoteTrashForLocalDelete(
          match.path,
          match.entry.driveId,
          match.entry.md5
        );
      } catch (err) {
        opErr = err;
        if (isNetworkOrOfflineError(err)) {
          this.enqueuePendingOp({
            kind: 'delete',
            path: match.path,
            driveId: match.entry.driveId,
            baseMd5: match.entry.md5,
          });
          await this.vault.saveIndex(this.index);
          this.log('warn', 'offline-queue', 'Queued offline delete', match.path);
        } else {
          this.log('error', 'delete', `Remote delete failed: ${String(err)}`, match.path);
          throw err;
        }
      } finally {
        this.endSyncOp(opErr);
      }
    });
  }

  private async executeRemoteTrashForLocalDelete(
    path: string,
    driveId?: string,
    baseMd5?: string
  ): Promise<void> {
    const entry = this.index.files[path];
    const targetId = driveId ?? entry?.driveId;
    const expectedMd5 = baseMd5 ?? entry?.md5;
    if (!targetId) return;

    // Pre-flight check: if remote was edited while we deleted locally, Edit-Wins-Over-Delete!
    const remoteMeta = await this.drive.getFileMetadata(targetId);
    if (
      remoteMeta &&
      !remoteMeta.trashed &&
      expectedMd5 &&
      remoteMeta.md5Checksum &&
      remoteMeta.md5Checksum !== expectedMd5
    ) {
      // Remote edited -> restore remote file locally instead of deleting it!
      const remoteBytes = await this.drive.downloadFile(targetId);
      await this.writeLocalEchoSuppressed(path, remoteBytes);
      if (isTextSyncPath(path)) {
        await this.vault.writeBase(targetId, utf8Decoder.decode(remoteBytes));
      }
      this.index.files[path] = {
        driveId: targetId,
        md5: remoteMeta.md5Checksum,
        mtime: this.now(),
        size: remoteBytes.byteLength,
        isText: isTextSyncPath(path),
        createdTime: remoteMeta.createdTime,
        modifiedTime: remoteMeta.modifiedTime,
      };
      await this.vault.saveIndex(this.index);
      this.log('info', 'edit-wins', 'Remote edit won over local delete — restored', path);
      return;
    }

    if (remoteMeta && !remoteMeta.trashed) {
      await this.drive.trashFile(targetId);
    }

    delete this.index.files[path];
    await this.vault.deleteBase(targetId);
    await this.vault.deletePrevBase(targetId);
    await this.vault.saveIndex(this.index);
    await this.emitSignals([{ id: targetId, path, trashed: true }]);
    this.log('info', 'delete', 'Trashed on Google Drive', path);
  }

  /**
   * Handles local vault `rename` events (both `TFile` and `TFolder`) across all 4 ignore transitions:
   * 1. ignored -> ignored (no-op)
   * 2. synced -> ignored (e.g. moved into `.trash/`): trash remote!
   * 3. ignored -> synced (e.g. moved out of `.trash/`): upload new file!
   * 4. synced -> synced:
   *    - Folder rename: 1 Drive PATCH + suppress child `TFile` cascade + keep `bases/<driveId>.txt`!
   *    - File rename (including case-only `note.md -> Note.md`): metadata-only Drive PATCH!
   */
  async handleLocalRename(
    rawOldPath: string,
    rawNewPath: string,
    isFolder: boolean
  ): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();

    const oldPath = normalizePath(rawOldPath);
    const newPath = normalizePath(rawNewPath);
    if (!oldPath || !newPath || oldPath === newPath) return;

    // Suppress echoes from remote renames and child cascades from a local TFolder rename
    if (this.echoSuppressor.consumeRename(oldPath, newPath)) {
      return;
    }

    const oldIgnored = this.ignoreMatcher.isIgnored(oldPath);
    const newIgnored = this.ignoreMatcher.isIgnored(newPath);

    // Transition 1: ignored -> ignored
    if (oldIgnored && newIgnored) return;

    // Transition 2: synced -> ignored (e.g. moved into .trash/ or ignored folder)
    if (!oldIgnored && newIgnored) {
      if (isFolder) {
        this.echoSuppressor.recordFolderRename(oldPath, newPath);
        await this.handleLocalFolderDeletedOrIgnored(oldPath);
      } else {
        await this.handleLocalDelete(oldPath);
      }
      return;
    }

    // Transition 3: ignored -> synced (e.g. restored from .trash/ or moved out of ignored folder)
    if (oldIgnored && !newIgnored) {
      if (isFolder) {
        this.echoSuppressor.recordFolderRename(oldPath, newPath);
        await this.uploadFolderTree(newPath);
      } else {
        await this.handleLocalCreateOrModify(newPath);
      }
      return;
    }

    // Transition 4: synced -> synced
    if (isFolder) {
      // Immediately suppress child TFile rename events Obsidian fires right after TFolder rename
      this.echoSuppressor.recordFolderRename(oldPath, newPath);

      await this.pathMutex.runExclusive([oldPath, newPath], async () => {
        const folderId = this.index.folderMap[oldPath];
        if (!folderId) {
          // Folder wasn't tracked on Drive yet -> upload any files inside newPath
          await this.uploadFolderTree(newPath);
          return;
        }

        // Persist crash-safe dirty rename BEFORE touching Drive (coalescing chained renames)
        const dirtyRec: DirtyRenameRecord = {
          oldPath,
          newPath,
          driveId: folderId,
          isFolder: true,
          startedAt: this.now(),
        };
        this.upsertDirtyRename(dirtyRec);
        await this.vault.saveIndex(this.index);

        this.beginSyncOp();
        let opErr: unknown;
        try {
          const oldParentId = await this.ensureRemoteFolder(dirname(oldPath));
          const newParentId = await this.ensureRemoteFolder(dirname(newPath));
          const movedParents = oldParentId !== newParentId;

          await this.drive.updateFileMetadata(folderId, {
            name: basename(newPath),
            addParents: movedParents ? [newParentId] : undefined,
            removeParents: movedParents ? [oldParentId] : undefined,
          });

          this.remapIndexFolderPrefix(oldPath, newPath, folderId);
          this.index.dirtyRenames = this.index.dirtyRenames.filter(
            (r) => !(r.driveId === folderId && r.newPath === newPath)
          );
          await this.vault.saveIndex(this.index);
          await this.emitSignals([
            {
              id: folderId,
              path: newPath,
              oldPath,
              isFolder: true,
            },
          ]);
          this.log('info', 'folder-rename', `Renamed folder ${oldPath} -> ${newPath}`, newPath);
        } catch (err) {
          opErr = err;
          if (isNetworkOrOfflineError(err)) {
            this.remapIndexFolderPrefix(oldPath, newPath, folderId);
            await this.vault.saveIndex(this.index);
            this.log('warn', 'offline-queue', `Recorded crash-safe folder rename ${oldPath} -> ${newPath}`, newPath);
          } else {
            this.log('error', 'folder-rename', `Folder rename failed: ${String(err)}`, newPath);
            throw err;
          }
        } finally {
          this.endSyncOp(opErr);
        }
      });
      return;
    }

    // File rename (synced -> synced, including case-only rename `note.md -> Note.md`)
    await this.pathMutex.runExclusive([oldPath, newPath], async () => {
      const entry = this.index.files[oldPath];
      if (!entry) {
        await this.handleLocalCreateOrModify(newPath);
        return;
      }

      const dirtyRec: DirtyRenameRecord = {
        oldPath,
        newPath,
        driveId: entry.driveId,
        isFolder: false,
        startedAt: this.now(),
      };
      this.upsertDirtyRename(dirtyRec);
      await this.vault.saveIndex(this.index);

      this.beginSyncOp();
      let opErr: unknown;
      try {
        const oldParentId = await this.ensureRemoteFolder(dirname(oldPath));
        const newParentId = await this.ensureRemoteFolder(dirname(newPath));
        const movedParents = oldParentId !== newParentId;

        await this.drive.updateFileMetadata(entry.driveId, {
          name: basename(newPath),
          addParents: movedParents ? [newParentId] : undefined,
          removeParents: movedParents ? [oldParentId] : undefined,
        });

        delete this.index.files[oldPath];
        this.index.files[newPath] = entry;
        this.index.dirtyRenames = this.index.dirtyRenames.filter(
          (r) => !(r.driveId === entry.driveId && r.newPath === newPath)
        );
        await this.vault.saveIndex(this.index);
        await this.emitSignals([
          {
            id: entry.driveId,
            path: newPath,
            oldPath,
            md5: entry.md5,
          },
        ]);
        this.log('info', 'rename', `Renamed ${oldPath} -> ${newPath}`, newPath);
      } catch (err) {
        opErr = err;
        if (isNetworkOrOfflineError(err)) {
          delete this.index.files[oldPath];
          this.index.files[newPath] = entry;
          await this.vault.saveIndex(this.index);
          this.log('warn', 'offline-queue', `Recorded crash-safe rename ${oldPath} -> ${newPath}`, newPath);
        } else {
          this.log('error', 'rename', `Rename failed: ${String(err)}`, newPath);
          throw err;
        }
      } finally {
        this.endSyncOp(opErr);
      }
    });
  }

  /**
   * Handles local vault `TFolder` creation (syncs empty folders across devices).
   */
  async handleLocalFolderCreate(rawFolderPath: string): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();
    const folderPath = normalizePath(rawFolderPath);
    if (!folderPath || this.ignoreMatcher.isIgnored(folderPath)) return;
    if (this.echoSuppressor.consumeFolderCreate(folderPath)) return;
    if (this.index.folderMap[folderPath]) return;

    await this.pathMutex.runExclusive(folderPath, async () => {
      if (this.index.folderMap[folderPath]) return;
      this.beginSyncOp();
      let opErr: unknown;
      try {
        const folderId = await this.ensureRemoteFolder(folderPath);
        await this.vault.saveIndex(this.index);
        await this.emitSignals([{ id: folderId, path: folderPath, isFolder: true }]);
        this.log('info', 'folder-create', `Created remote folder`, folderPath);
      } catch (err) {
        opErr = err;
        if (!isNetworkOrOfflineError(err)) {
          this.log('error', 'folder-create', `Folder create failed: ${String(err)}`, folderPath);
          throw err;
        }
      } finally {
        this.endSyncOp(opErr);
      }
    });
  }

  /**
   * Handles local vault `TFolder` deletion (trashes folder & descendants on Drive).
   */
  async handleLocalFolderDelete(rawFolderPath: string): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();
    const folderPath = normalizePath(rawFolderPath);
    if (!folderPath || this.ignoreMatcher.isIgnored(folderPath)) return;
    if (this.echoSuppressor.consumeDelete(folderPath)) return;

    await this.pathMutex.runExclusive(folderPath, async () => {
      this.beginSyncOp();
      let opErr: unknown;
      try {
        await this.handleLocalFolderDeletedOrIgnored(folderPath);
      } catch (err) {
        opErr = err;
        if (!isNetworkOrOfflineError(err)) {
          this.log('error', 'folder-delete', `Folder delete failed: ${String(err)}`, folderPath);
          throw err;
        }
      } finally {
        this.endSyncOp(opErr);
      }
    });
  }

  private async handleLocalFolderDeletedOrIgnored(oldFolderPath: string): Promise<void> {
    const folderId = this.index.folderMap[oldFolderPath];
    const prefix = oldFolderPath + '/';
    const descendantPaths = Object.keys(this.index.files).filter((p) =>
      p.startsWith(prefix)
    );

    if (folderId) {
      try {
        await this.drive.trashFile(folderId);
        await this.emitSignals([{ id: folderId, path: oldFolderPath, trashed: true, isFolder: true }]);
      } catch (err) {
        if (isNetworkOrOfflineError(err)) {
          for (const p of descendantPaths) {
            const e = this.index.files[p];
            this.enqueuePendingOp({ kind: 'delete', path: p, driveId: e.driveId, baseMd5: e.md5 });
          }
          await this.vault.saveIndex(this.index);
          return;
        }
        throw err;
      }
    }

    for (const p of descendantPaths) {
      const e = this.index.files[p];
      delete this.index.files[p];
      await this.vault.deleteBase(e.driveId);
      await this.vault.deletePrevBase(e.driveId);
    }
    for (const fPath of Object.keys(this.index.folderMap)) {
      if (fPath === oldFolderPath || fPath.startsWith(prefix)) {
        delete this.index.folderMap[fPath];
      }
    }
    await this.vault.saveIndex(this.index);
  }

  private async uploadFolderTree(folderPath: string): Promise<void> {
    const prefix = folderPath + '/';
    const files = await this.vault.listFiles();
    for (const f of files) {
      if (
        (f.path === folderPath || f.path.startsWith(prefix)) &&
        !this.ignoreMatcher.isIgnored(f.path)
      ) {
        await this.handleLocalCreateOrModify(f.path);
      }
    }
  }

  /**
   * Fast-Path Signal Pull (P1 #1):
   * Uses the rolling 10-item ring buffer in `sync_signals/{vaultId}` to either
   * skip unchanged files (0 HTTP calls) or fire 1 single `GET ?alt=media`, verifying
   * `md5(bytes) === signal.md5` locally, before advancing `changes.list` asynchronously.
   *
   * Deduplicates live pulses by `pulseId` (never dropping concurrent `seq <= prevSeq` pulses
   * from peers) and commits `lastSeenSignalSeq` / `lastSeenPulseId` ONLY AFTER pull/delta succeeds.
   */
  async handleIncomingSignal(doc: SignalDocument): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();

    if (doc.sender === this.settings.deviceId) return;

    const prevSeq = this.index.lastSeenSignalSeq;
    const prevPulseId = this.index.lastSeenPulseId;

    // Deduplicate strictly by pulseId when present; fall back to seq for legacy pulses
    if (doc.pulseId) {
      if (prevPulseId && doc.pulseId === prevPulseId) return;
    } else if (doc.seq <= prevSeq) {
      return;
    }

    const commitSignalCursor = async (): Promise<void> => {
      if (doc.seq > this.index.lastSeenSignalSeq) {
        this.index.lastSeenSignalSeq = doc.seq;
      }
      if (doc.pulseId) {
        this.index.lastSeenPulseId = doc.pulseId;
      }
      await this.vault.saveIndex(this.index);
    };

    const concurrentSeqCollision = doc.seq <= prevSeq;

    const newEntries = (doc.entries ?? [])
      .filter((e) => e.seq > prevSeq)
      .sort((a, b) => a.seq - b.seq);

    const ringBufferOverflowed =
      prevSeq > 0 &&
      (doc.entries?.length ?? 0) >= SIGNAL_RING_BUFFER_SIZE &&
      newEntries.length === (doc.entries?.length ?? 0);

    const hasStructuralChange = newEntries.some(
      (e) => e.isFolder || e.oldPath || e.trashed
    );

    if (
      concurrentSeqCollision ||
      doc.requiresDeltaSync ||
      newEntries.length === 0 ||
      ringBufferOverflowed ||
      hasStructuralChange
    ) {
      // Do NOT commit signal cursor until delta sync succeeds!
      await this.runDeltaSync();
      await commitSignalCursor();
      return;
    }

    // Pure file-content fast path (1 GET per changed file!)
    let needsImmediateDelta = false;
    this.beginSyncOp();
    let opErr: unknown;
    try {
      for (const entry of newEntries) {
        const normPath = normalizePath(entry.path);
        if (!normPath || this.ignoreMatcher.isIgnored(normPath)) continue;

        await this.pathMutex.runExclusive(normPath, async () => {
          const existing = this.index.files[normPath];
          if (existing && existing.driveId !== entry.id) {
            // Different driveId at same path (dual-create or stale trashed loser in ring buffer):
            // NEVER fast-path overwrite — defer to 2-pass delta sync with full metadata & canonical election!
            needsImmediateDelta = true;
            return;
          }
          if (
            existing &&
            existing.driveId === entry.id &&
            entry.md5 &&
            existing.md5 === entry.md5
          ) {
            // Already up to date -> 0 HTTP calls!
            return;
          }

          // Single GET ?alt=media!
          let bytes: Uint8Array;
          try {
            bytes = await this.drive.downloadFile(entry.id);
          } catch {
            needsImmediateDelta = true;
            return;
          }

          const downloadedMd5 = md5Bytes(bytes);
          if (entry.md5 && downloadedMd5 !== entry.md5) {
            // Signal raced with a newer Drive revision; fall back to delta sync
            needsImmediateDelta = true;
            return;
          }

          const syntheticMeta: DriveFileMetadata = {
            id: entry.id,
            name: basename(normPath),
            mimeType: guessMimeType(normPath),
            md5Checksum: downloadedMd5,
            size: String(bytes.byteLength),
            trashed: false,
            modifiedTime: new Date(doc.updatedAt || this.now()).toISOString(),
            appProperties: {
              ...(entry.parentMd5 !== undefined ? { parentMd5: entry.parentMd5 } : {}),
              writer: doc.sender,
            },
          };

          await this.applyRemoteFileLocked(syntheticMeta, normPath, bytes);
        });
      }
      await this.vault.saveIndex(this.index);
    } catch (err) {
      opErr = err;
      this.log('warn', 'fast-path', `Fast-path pull fallback to delta sync: ${String(err)}`);
      needsImmediateDelta = true;
    } finally {
      this.endSyncOp(opErr);
    }

    // Always walk `changes.list(savedPageToken)` (NEVER jump cursor via getStartPageToken!).
    // If `needsImmediateDelta` is true (even when startPageToken is null), `runDeltaSync()`
    // runs (delegating to fullReconcile if needed) and propagates failures BEFORE cursor commit!
    if (needsImmediateDelta || this.index.startPageToken) {
      await this.runDeltaSync();
    }

    await commitSignalCursor();
  }

  /**
   * 2-Pass `changes.list` Delta Sync (P0 #4):
   * - Paginates ALL pages starting from `index.startPageToken`.
   * - Filters strictly to ancestor chain reaching `vaultRootFolderId` (multi-vault safe!).
   * - Pass 1: Folders (renames, moves, trash, duplicate folder deduplication).
   * - Pass 2: Files (`removed: true` via reverse map, renames, duplicates, APFS case collisions, content).
   * - Persists `newStartPageToken` ONLY AFTER both passes finish cleanly.
   */
  async runDeltaSync(): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();

    if (this.deltaSyncPromise) {
      this.deltaSyncQueued = true;
      return this.deltaSyncPromise;
    }

    const execute = async (): Promise<void> => {
      do {
        this.deltaSyncQueued = false;
        await this.runDeltaSyncOnce();
      } while (this.deltaSyncQueued && !this.paused);
    };

    this.deltaSyncPromise = execute().finally(() => {
      this.deltaSyncPromise = null;
    });

    return this.deltaSyncPromise;
  }

  private async runDeltaSyncOnce(): Promise<void> {
    await this.recoverDirtyRenames();
    if (this.index.pendingOps.length > 0) {
      await this.flushOfflineQueue();
    }

    if (!this.index.startPageToken) {
      await this.fullReconcile();
      return;
    }

    this.beginSyncOp();
    let opErr: unknown;
    try {
      const rootId = await this.ensureRootFolder();
      let pageToken: string | undefined = this.index.startPageToken;
      let newStartPageToken: string | undefined;

      // Collapse multiple changes for the same fileId across pages, keeping the latest
      const latestByFileId = new Map<string, DriveChange>();

      while (pageToken) {
        const page = await this.drive.listChanges(pageToken);
        for (const ch of page.changes) {
          latestByFileId.set(ch.fileId, ch);
        }
        if (page.nextPageToken) {
          pageToken = page.nextPageToken;
        } else {
          newStartPageToken = page.newStartPageToken;
          pageToken = undefined;
        }
      }

      if (latestByFileId.size === 0) {
        if (newStartPageToken) {
          this.index.startPageToken = newStartPageToken;
          await this.vault.saveIndex(this.index);
        }
        return;
      }

      // Build folder metadata graph from existing index + incoming folder changes
      const folderMetaById = new Map<string, DriveFileMetadata>();
      const folderIdToOldPath = this.buildFolderIdToPathMap();

      // Seed existing known folders as synthetic metadata nodes
      for (const [fPath, fId] of Object.entries(this.index.folderMap)) {
        if (fPath === '') continue;
        const parentPath = dirname(fPath);
        const parentId = this.index.folderMap[parentPath] ?? rootId;
        folderMetaById.set(fId, {
          id: fId,
          name: basename(fPath),
          mimeType: DRIVE_FOLDER_MIME,
          parents: [parentId],
          trashed: false,
        });
      }

      // Overlay incoming folder changes
      const folderChanges: DriveChange[] = [];
      const fileChanges: DriveChange[] = [];

      for (const ch of latestByFileId.values()) {
        const isKnownFolder = folderIdToOldPath.has(ch.fileId);
        const isIncomingFolder = ch.file?.mimeType === DRIVE_FOLDER_MIME;
        if (isKnownFolder || isIncomingFolder) {
          folderChanges.push(ch);
          if (ch.removed || ch.file?.trashed) {
            folderMetaById.delete(ch.fileId);
          } else if (ch.file) {
            folderMetaById.set(ch.fileId, ch.file);
          }
        } else {
          fileChanges.push(ch);
        }
      }

      // Helper to resolve an item's relative path under `rootId` (fetching missing parent metadata lazily)
      const fetchedMissingMeta = new Map<string, DriveFileMetadata | null>();
      const getFolderNode = async (id: string): Promise<DriveFileMetadata | null> => {
        if (folderMetaById.has(id)) return folderMetaById.get(id)!;
        if (fetchedMissingMeta.has(id)) return fetchedMissingMeta.get(id)!;
        const meta = await this.drive.getFileMetadata(id);
        fetchedMissingMeta.set(id, meta);
        if (meta && !meta.trashed && meta.mimeType === DRIVE_FOLDER_MIME) {
          folderMetaById.set(meta.id, meta);
        }
        return meta;
      };

      const resolvePathUnderRoot = async (
        item: DriveFileMetadata
      ): Promise<string | null> => {
        if (item.id === rootId) return '';
        const segments: string[] = [item.name];
        let currentParents = item.parents ?? [];
        const visited = new Set<string>([item.id]);

        while (currentParents.length > 0) {
          const parentId = currentParents[0];
          if (parentId === rootId) {
            return normalizePath(segments.reverse().join('/'));
          }
          if (visited.has(parentId)) return null;
          visited.add(parentId);

          const parentNode = await getFolderNode(parentId);
          if (!parentNode || parentNode.trashed) {
            return null;
          }
          segments.push(parentNode.name);
          currentParents = parentNode.parents ?? [];
        }
        return null;
      };

      // ================= PASS 1: FOLDERS =================
      const liveFoldersByPath = new Map<string, DriveFileMetadata[]>();

      for (const ch of folderChanges) {
        if (ch.fileId === rootId) continue;
        const oldPath = folderIdToOldPath.get(ch.fileId);

        if (ch.removed || ch.file?.trashed) {
          if (oldPath) {
            await this.handleRemoteFolderDeleted(oldPath, Boolean(ch.removed));
          }
          continue;
        }

        if (!ch.file) continue;
        const newPath = await resolvePathUnderRoot(ch.file);
        if (!newPath) {
          // Folder belongs to another vault OR was moved outside vaultRootFolderId
          if (oldPath) {
            await this.handleRemoteFolderDeleted(oldPath, false);
          }
          continue;
        }

        if (this.ignoreMatcher.isIgnored(newPath)) {
          if (oldPath) {
            await this.handleRemoteFolderDeleted(oldPath, false);
          }
          continue;
        }

        const bucket = liveFoldersByPath.get(newPath) ?? [];
        bucket.push(ch.file);
        liveFoldersByPath.set(newPath, bucket);

        if (oldPath && oldPath !== newPath) {
          // Folder renamed or moved on Drive!
          await this.pathMutex.runExclusive([oldPath, newPath], async () => {
            this.echoSuppressor.recordFolderRename(oldPath, newPath);
            if (await this.vault.exists(oldPath)) {
              await this.vault.renamePath(oldPath, newPath);
            }
            this.remapIndexFolderPrefix(oldPath, newPath, ch.file!.id);
            this.log('info', 'remote-folder-rename', `Remote folder renamed ${oldPath} -> ${newPath}`, newPath);
          });
        } else if (!oldPath) {
          // New folder (or potential duplicate folder!)
          const existingIdAtPath = this.index.folderMap[newPath];
          if (existingIdAtPath && existingIdAtPath !== ch.file.id) {
            const existingMeta =
              (await getFolderNode(existingIdAtPath)) ?? {
                id: existingIdAtPath,
                name: basename(newPath),
                mimeType: DRIVE_FOLDER_MIME,
              };
            if (!existingMeta.trashed) {
              bucket.push(existingMeta);
            } else {
              this.index.folderMap[newPath] = ch.file.id;
            }
          } else {
            this.index.folderMap[newPath] = ch.file.id;
          }
        }
      }

      // Deduplicate any duplicate live folders discovered at the same path (parent-first order)
      // and ensure empty remote folders exist locally (echo-suppressed)
      const sortedLiveFolderPaths = Array.from(liveFoldersByPath.keys()).sort(
        (a, b) => a.split('/').length - b.split('/').length
      );
      for (const folderPath of sortedLiveFolderPaths) {
        const candidates = liveFoldersByPath.get(folderPath)!;
        const uniqueById = Array.from(
          new Map(candidates.map((c) => [c.id, c])).values()
        );
        if (uniqueById.length > 1) {
          await this.deduplicateFolders(folderPath, uniqueById);
        } else if (uniqueById.length === 1) {
          this.index.folderMap[folderPath] = uniqueById[0].id;
        }
        if (!(await this.vault.exists(folderPath))) {
          this.echoSuppressor.recordFolderCreate(folderPath);
          await this.vault.ensureFolder(folderPath);
        }
      }

      // ================= PASS 2: FILES =================
      const driveIdToPath = this.buildDriveIdToPathMap();

      // Group live files by resolved path to detect dual-create duplicates cleanly
      const liveFilesByPath = new Map<string, DriveFileMetadata[]>();

      for (const ch of fileChanges) {
        const oldPath = driveIdToPath.get(ch.fileId);

        // `change.removed === true` has `change.file === undefined` -> use reverse map!
        if (ch.removed) {
          if (oldPath) {
            await this.pathMutex.runExclusive(oldPath, async () => {
              await this.handleRemoteDeleteLocked(oldPath, ch.fileId, true);
            });
          }
          continue;
        }

        if (!ch.file) continue;

        if (ch.file.trashed) {
          const targetPath = oldPath ?? (await resolvePathUnderRoot(ch.file));
          if (targetPath) {
            await this.pathMutex.runExclusive(targetPath, async () => {
              await this.handleRemoteDeleteLocked(targetPath, ch.fileId, false);
            });
          }
          continue;
        }

        const resolvedPath = await resolvePathUnderRoot(ch.file);
        if (!resolvedPath) {
          // Multi-vault isolation: file belongs to another vault or moved outside `vaultRootFolderId`!
          if (oldPath) {
            await this.pathMutex.runExclusive(oldPath, async () => {
              await this.handleRemoteDeleteLocked(oldPath, ch.fileId, false);
            });
          }
          continue;
        }

        if (this.ignoreMatcher.isIgnored(resolvedPath)) {
          if (oldPath) {
            await this.pathMutex.runExclusive(oldPath, async () => {
              await this.handleRemoteDeleteLocked(oldPath, ch.fileId, false);
            });
          }
          continue;
        }

        // Check remote rename/move (same driveId, different path — including case-only rename!)
        if (oldPath && oldPath !== resolvedPath) {
          // Verify oldPath isn't a case-conflict disambiguated local path for the same name
          const isCaseConflictAlias =
            this.vault.caseInsensitive &&
            oldPath === buildCaseConflictPath(resolvedPath, ch.fileId);

          if (!isCaseConflictAlias) {
            await this.pathMutex.runExclusive([oldPath, resolvedPath], async () => {
              const entry = this.index.files[oldPath];
              if (entry && entry.driveId === ch.fileId) {
                this.echoSuppressor.recordRename(oldPath, resolvedPath);
                if (await this.vault.exists(oldPath)) {
                  await this.vault.renamePath(oldPath, resolvedPath);
                }
                delete this.index.files[oldPath];
                this.index.files[resolvedPath] = entry;
                driveIdToPath.set(ch.fileId, resolvedPath);
                this.log('info', 'remote-rename', `Remote renamed ${oldPath} -> ${resolvedPath}`, resolvedPath);
              }
            });
          }
        }

        const list = liveFilesByPath.get(resolvedPath) ?? [];
        list.push(ch.file);
        liveFilesByPath.set(resolvedPath, list);
      }

      // Process each resolved file path (handling duplicates & content updates)
      for (const [resolvedPath, incomingFiles] of liveFilesByPath.entries()) {
        await this.pathMutex.runExclusive(resolvedPath, async () => {
          const allCandidates = [...incomingFiles];
          const existingEntry = this.index.files[resolvedPath];
          if (
            existingEntry &&
            !allCandidates.some((f) => f.id === existingEntry.driveId)
          ) {
            // Check whether existing indexed driveId is STILL live at this same path (dual-create collision!)
            const existingMeta = await this.drive.getFileMetadata(existingEntry.driveId);
            if (existingMeta && !existingMeta.trashed) {
              const existingResolved = await resolvePathUnderRoot(existingMeta);
              if (existingResolved === resolvedPath) {
                allCandidates.push(existingMeta);
              }
            }
          }

          if (allCandidates.length > 1) {
            await this.deduplicateFilesAtPathLocked(resolvedPath, allCandidates);
          } else {
            const targetFile = allCandidates[0];
            // If this driveId is currently stored under a case-conflict alias, keep using that alias
            const currentPath = driveIdToPath.get(targetFile.id);
            const effectivePath =
              currentPath &&
              this.vault.caseInsensitive &&
              currentPath === buildCaseConflictPath(resolvedPath, targetFile.id)
                ? currentPath
                : resolvedPath;
            await this.applyRemoteFileLocked(targetFile, effectivePath);
          }
        });
      }

      // Persist cursor ONLY AFTER both passes succeeded
      if (newStartPageToken) {
        this.index.startPageToken = newStartPageToken;
      }
      await this.vault.saveIndex(this.index);
    } catch (err) {
      opErr = err;
      throw err;
    } finally {
      this.endSyncOp(opErr);
    }
  }

  private async handleRemoteFolderDeleted(
    oldFolderPath: string,
    permanentlyRemoved: boolean
  ): Promise<void> {
    const prefix = oldFolderPath + '/';
    const descendants = Object.keys(this.index.files).filter((p) =>
      p.startsWith(prefix)
    );

    for (const filePath of descendants) {
      await this.pathMutex.runExclusive(filePath, async () => {
        const entry = this.index.files[filePath];
        if (!entry) return;
        await this.handleRemoteDeleteLocked(filePath, entry.driveId, permanentlyRemoved);
      });
    }

    for (const fPath of Object.keys(this.index.folderMap)) {
      if (fPath === oldFolderPath || fPath.startsWith(prefix)) {
        delete this.index.folderMap[fPath];
      }
    }
    this.echoSuppressor.recordDelete(oldFolderPath);
    await this.vault.removeEmptyFolder(oldFolderPath);
  }

  /**
   * Handles remote deletion (either `trashed: true`, `removed: true`, or moved outside vault).
   * Enforces **Edit-Wins-Over-Delete** (including `404` re-create when permanently removed!).
   */
  private async handleRemoteDeleteLocked(
    path: string,
    driveId: string,
    permanentlyRemoved: boolean
  ): Promise<void> {
    const entry = this.index.files[path];
    if (!entry || entry.driveId !== driveId) return;

    const localExists = await this.vault.exists(path);
    if (!localExists) {
      delete this.index.files[path];
      await this.vault.deleteBase(driveId);
      await this.vault.deletePrevBase(driveId);
      return;
    }

    const localBytes = await this.vault.readBinary(path);
    const localMd5 = md5Bytes(localBytes);

    if (localMd5 === entry.md5) {
      // Local unchanged -> honor remote delete by moving local file to Obsidian `.trash/`
      this.echoSuppressor.recordDelete(path);
      await this.vault.trashFile(path);
      delete this.index.files[path];
      await this.vault.deleteBase(driveId);
      await this.vault.deletePrevBase(driveId);
      this.log('info', 'remote-delete', 'Moved to .trash/ due to remote delete', path);
      return;
    }

    // Local edited while remote was deleted -> EDIT WINS OVER DELETE!
    const mimeType = guessMimeType(path);
    const isText = isTextSyncPath(path);

    if (permanentlyRemoved) {
      // File is permanently gone (404) -> re-create on Drive!
      const parentId = await this.ensureRemoteFolder(dirname(path));
      const created = await this.drive.createFile({
        name: basename(path),
        parentId,
        mimeType,
        content: localBytes,
        appProperties: {
          parentMd5: '',
          writer: this.settings.deviceId,
        },
      });
      await this.vault.deleteBase(driveId);
      await this.vault.deletePrevBase(driveId);
      if (isText) {
        await this.vault.writeBase(created.id, utf8Decoder.decode(localBytes));
      }
      this.index.files[path] = {
        driveId: created.id,
        md5: localMd5,
        mtime: this.now(),
        size: localBytes.byteLength,
        isText,
        createdTime: created.createdTime,
        modifiedTime: created.modifiedTime,
      };
      await this.emitSignals([{ id: created.id, path, md5: localMd5, parentMd5: '' }]);
      this.log('info', 'edit-wins', 'Re-created permanently removed file with local edits', path);
      return;
    }

    // Remote trashed -> attempt untrash + update, falling back to createFile if 404
    try {
      const updated = await this.drive.updateFileContent(driveId, {
        mimeType,
        content: localBytes,
        trashed: false,
        appProperties: {
          parentMd5: entry.md5,
          writer: this.settings.deviceId,
        },
      });
      if (isText) {
        await this.vault.writeBase(driveId, utf8Decoder.decode(localBytes));
      }
      this.index.files[path] = {
        ...entry,
        md5: localMd5,
        prevMd5: entry.md5,
        mtime: this.now(),
        size: localBytes.byteLength,
        modifiedTime: updated.modifiedTime,
      };
      await this.emitSignals([
        { id: updated.id, path, md5: localMd5, parentMd5: entry.md5 },
      ]);
      this.log('info', 'edit-wins', 'Untrashed and re-uploaded locally edited file', path);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        await this.handleRemoteDeleteLocked(path, driveId, true);
        return;
      }
      throw err;
    }
  }

  /**
   * Deduplicates multiple live Drive folders resolving to the same `folderPath`.
   * Elects canonical winner deterministically, re-parents loser children, and trashes losers.
   */
  private async deduplicateFolders(
    folderPath: string,
    candidates: readonly DriveFileMetadata[]
  ): Promise<DriveFileMetadata> {
    const { winner, losers } = electCanonical(candidates);
    this.index.folderMap[folderPath] = winner.id;

    if (losers.length === 0) return winner;

    // Fetch all live items once to re-parent any children currently inside loser folders
    const allItems = await this.drive.listAllItems();
    const loserIds = new Set(losers.map((l) => l.id));

    for (const item of allItems) {
      if (item.trashed || !item.parents) continue;
      const matchedLoser = item.parents.find((p) => loserIds.has(p));
      if (matchedLoser) {
        await this.drive.updateFileMetadata(item.id, {
          addParents: [winner.id],
          removeParents: [matchedLoser],
        });
      }
    }

    for (const loser of losers) {
      await this.drive.trashFile(loser.id);
      this.log(
        'info',
        'dedup-folder',
        `Deduplicated folder ${folderPath}: kept ${winner.id}, trashed ${loser.id}`,
        folderPath
      );
    }

    return winner;
  }

  /**
   * Deduplicates multiple live Drive files resolving to the same `path` (e.g. offline dual-create).
   * Elects canonical winner deterministically, merges or creates conflict copy, updates winner, and trashes losers.
   */
  private async deduplicateFilesAtPathLocked(
    path: string,
    candidates: readonly DriveFileMetadata[]
  ): Promise<void> {
    const { winner, losers } = electCanonical(candidates);
    let winnerBytes = await this.drive.downloadFile(winner.id);
    let winnerMd5 = md5Bytes(winnerBytes);
    const isText = isTextSyncPath(path);

    for (const loser of losers) {
      // Re-check live Drive state before creating a conflict copy so concurrent
      // multi-device wakes don't duplicate conflict resolution for an already-trashed loser!
      const freshLoser = await this.drive.getFileMetadata(loser.id);
      if (!freshLoser || freshLoser.trashed) {
        continue;
      }

      if (freshLoser.md5Checksum && freshLoser.md5Checksum === winnerMd5) {
        await this.drive.trashFile(freshLoser.id);
        continue;
      }

      const loserBytes = await this.drive.downloadFile(freshLoser.id);
      const loserMd5 = md5Bytes(loserBytes);

      if (loserMd5 === winnerMd5) {
        await this.drive.trashFile(freshLoser.id);
        continue;
      }

      // Compute deterministic conflict copy path from loser's metadata so even simultaneous
      // races across Mac/iPhone/Android converge to strictly 1 conflict filename!
      const loserTag =
        freshLoser.appProperties?.writer?.slice(0, 8) || freshLoser.id.slice(-6);
      const loserDate = freshLoser.createdTime
        ? new Date(freshLoser.createdTime)
        : new Date(0);
      const deterministicConflictPath = buildConflictPath(path, loserTag, loserDate);

      if (isText) {
        const winnerText = utf8Decoder.decode(winnerBytes);
        const loserText = utf8Decoder.decode(loserBytes);
        const res = merge3('', winnerText, loserText, {
          path,
          validateJson: isJsonPath(path),
        });

        if (res.status === 'clean' && res.merged !== undefined) {
          const mergedBytes = utf8Encoder.encode(res.merged);
          const mergedMd5 = md5Bytes(mergedBytes);
          if (mergedMd5 !== winnerMd5) {
            await this.drive.updateFileContent(winner.id, {
              mimeType: guessMimeType(path),
              content: mergedBytes,
              appProperties: {
                parentMd5: winnerMd5,
                writer: this.settings.deviceId,
              },
            });
            winnerBytes = mergedBytes;
            winnerMd5 = mergedMd5;
          }
        } else {
          // Conflict: keep canonical winner at `path`, save loser at deterministic conflict path
          const existingConflict = this.index.files[deterministicConflictPath];
          if (!existingConflict || existingConflict.md5 !== loserMd5) {
            const sig = await this.writeAndUploadConflictCopy(
              deterministicConflictPath,
              loserBytes
            );
            await this.emitSignals([sig]);
            this.recordConflict(path, deterministicConflictPath, 'dual-create-collision');
          }
        }
      } else {
        // Binary dual-create collision: keep winner at canonical, save loser at deterministic conflict path
        const existingConflict = this.index.files[deterministicConflictPath];
        if (!existingConflict || existingConflict.md5 !== loserMd5) {
          const sig = await this.writeAndUploadConflictCopy(
            deterministicConflictPath,
            loserBytes
          );
          await this.emitSignals([sig]);
          this.recordConflict(path, deterministicConflictPath, 'binary-dual-create');
        }
      }

      await this.drive.trashFile(freshLoser.id);
      this.log(
        'info',
        'dedup-file',
        `Deduplicated ${path}: kept ${winner.id}, trashed ${freshLoser.id}`,
        path
      );
    }

    // Apply canonical winner locally (and reconcile with any uncommitted local edits)
    const winnerMeta: DriveFileMetadata = {
      ...winner,
      md5Checksum: winnerMd5,
      size: String(winnerBytes.byteLength),
    };
    await this.applyRemoteFileLocked(winnerMeta, path, winnerBytes);
  }

  /**
   * Single-Query Initial Sync & Full 3-State Existence Matrix Reconcile (P1 #5 & P0 #9).
   */
  async fullReconcile(): Promise<void> {
    if (this.paused) return;
    await this.ensureInitialized();

    if (this.reconcilePromise) {
      return this.reconcilePromise;
    }

    const run = async (): Promise<void> => {
      await this.recoverDirtyRenames();
      if (this.index.pendingOps.length > 0) {
        await this.flushOfflineQueue();
      }

      this.beginSyncOp();
      const started = this.now();
      let opErr: unknown;
      const batchSignals: OutgoingSignalItem[] = [];

      try {
        const rootId = await this.ensureRootFolder();

        // Capture Drive change cursor BEFORE inventory so concurrent remote edits during reconcile are never missed!
        const tokenBefore = await this.drive.getStartPageToken();

        // Single paginated query fetching all non-trashed items (P1 #5)
        const allRemoteItems = await this.drive.listAllItems();

        // Partition folders vs files and build ancestor map in memory
        const folderById = new Map<string, DriveFileMetadata>();
        const remoteFilesRaw: DriveFileMetadata[] = [];

        for (const item of allRemoteItems) {
          if (item.trashed) continue;
          if (item.mimeType === DRIVE_FOLDER_MIME) {
            folderById.set(item.id, item);
          } else {
            remoteFilesRaw.push(item);
          }
        }

        const resolveItemPath = (item: DriveFileMetadata): string | null => {
          if (item.id === rootId) return '';
          const segs: string[] = [item.name];
          let parents = item.parents ?? [];
          const visited = new Set<string>([item.id]);
          while (parents.length > 0) {
            const pId = parents[0];
            if (pId === rootId) {
              return normalizePath(segs.reverse().join('/'));
            }
            if (visited.has(pId)) return null;
            visited.add(pId);
            const parentFolder = folderById.get(pId);
            if (!parentFolder || parentFolder.trashed) return null;
            segs.push(parentFolder.name);
            parents = parentFolder.parents ?? [];
          }
          return null;
        };

        // Resolve and deduplicate remote folders under `rootId`
        const remoteFoldersByPath = new Map<string, DriveFileMetadata[]>();
        for (const folder of folderById.values()) {
          if (folder.id === rootId) continue;
          const rel = resolveItemPath(folder);
          if (!rel || this.ignoreMatcher.isIgnored(rel)) continue;
          const arr = remoteFoldersByPath.get(rel) ?? [];
          arr.push(folder);
          remoteFoldersByPath.set(rel, arr);
        }

        // Rebuild folderMap from live remote folders (deduplicating any duplicates)
        this.index.folderMap = { '': rootId };
        const sortedFolderPaths = Array.from(remoteFoldersByPath.keys()).sort(
          (a, b) => a.split('/').length - b.split('/').length
        );
        for (const fPath of sortedFolderPaths) {
          const candidates = remoteFoldersByPath.get(fPath)!;
          if (candidates.length > 1) {
            const winner = await this.deduplicateFolders(fPath, candidates);
            this.index.folderMap[fPath] = winner.id;
            // Re-point in-memory children of loser folders to winner for file resolution below
            const loserIds = new Set(candidates.filter((c) => c.id !== winner.id).map((c) => c.id));
            for (const f of remoteFilesRaw) {
              if (f.parents) {
                f.parents = f.parents.map((p) => (loserIds.has(p) ? winner.id : p));
              }
            }
            for (const sub of folderById.values()) {
              if (sub.parents) {
                sub.parents = sub.parents.map((p) => (loserIds.has(p) ? winner.id : p));
              }
            }
          } else {
            this.index.folderMap[fPath] = candidates[0].id;
          }
          if (!(await this.vault.exists(fPath))) {
            this.echoSuppressor.recordFolderCreate(fPath);
            await this.vault.ensureFolder(fPath);
          }
        }

        // Sync local empty folders that do not exist on Drive yet
        const localFolders = (await this.vault.listFolders())
          .map((f) => normalizePath(f))
          .filter((f) => f && !this.ignoreMatcher.isIgnored(f))
          .sort((a, b) => a.split('/').length - b.split('/').length);
        for (const lf of localFolders) {
          if (!this.index.folderMap[lf]) {
            const folderId = await this.ensureRemoteFolder(lf);
            batchSignals.push({ id: folderId, path: lf, isFolder: true });
          }
        }

        // Resolve remote files under `rootId` and group by path (to catch duplicates)
        const remoteFilesByPath = new Map<string, DriveFileMetadata[]>();
        for (const file of remoteFilesRaw) {
          const rel = resolveItemPath(file);
          if (!rel || this.ignoreMatcher.isIgnored(rel)) continue;
          const arr = remoteFilesByPath.get(rel) ?? [];
          arr.push(file);
          remoteFilesByPath.set(rel, arr);
        }

        // Deduplicate any remote duplicate files before running the 3-state matrix
        const remoteCanonicalByPath = new Map<string, DriveFileMetadata>();
        for (const [fPath, candidates] of remoteFilesByPath.entries()) {
          if (candidates.length > 1) {
            await this.pathMutex.runExclusive(fPath, async () => {
              await this.deduplicateFilesAtPathLocked(fPath, candidates);
            });
            const entry = this.index.files[fPath];
            if (entry) {
              const { winner } = electCanonical(candidates);
              remoteCanonicalByPath.set(fPath, {
                ...winner,
                md5Checksum: entry.md5,
              });
            }
          } else {
            remoteCanonicalByPath.set(fPath, candidates[0]);
          }
        }

        // Scan local vault files
        const localFilesList = await this.vault.listFiles();
        const localByPath = new Map<string, { path: string; size: number; mtime: number }>();
        for (const lf of localFilesList) {
          if (this.ignoreMatcher.isIgnored(lf.path)) continue;
          if (this.isOversized(lf.size)) continue;
          localByPath.set(lf.path, lf);
        }

        // Handle case-only renames on case-insensitive APFS before union:
        // If remote has `Note.md` (same driveId as indexed `note.md`), rename local `note.md` -> `Note.md`.
        const driveIdToRemotePath = new Map<string, string>();
        for (const [rPath, rMeta] of remoteCanonicalByPath.entries()) {
          driveIdToRemotePath.set(rMeta.id, rPath);
        }
        for (const [idxPath, entry] of Object.entries({ ...this.index.files })) {
          const rPath = driveIdToRemotePath.get(entry.driveId);
          if (rPath && rPath !== idxPath) {
            const isCaseConflictAlias =
              this.vault.caseInsensitive &&
              idxPath === buildCaseConflictPath(rPath, entry.driveId);
            if (!isCaseConflictAlias && !localByPath.has(rPath) && localByPath.has(idxPath)) {
              this.echoSuppressor.recordRename(idxPath, rPath);
              await this.vault.renamePath(idxPath, rPath);
              const lf = localByPath.get(idxPath)!;
              localByPath.delete(idxPath);
              localByPath.set(rPath, { ...lf, path: rPath });
              delete this.index.files[idxPath];
              this.index.files[rPath] = entry;
            }
          }
        }

        // Compute union of all paths across (Index ∪ Local ∪ Remote)
        const allPaths = new Set<string>([
          ...Object.keys(this.index.files),
          ...localByPath.keys(),
          ...remoteCanonicalByPath.keys(),
        ]);

        // Pre-sort paths deterministically (ensuring case-collision winners process first)
        const orderedPaths = Array.from(allPaths).sort((a, b) => {
          const rA = remoteCanonicalByPath.get(a);
          const rB = remoteCanonicalByPath.get(b);
          if (this.vault.caseInsensitive && foldPath(a) === foldPath(b) && rA && rB) {
            const { winner } = electCanonical([rA, rB]);
            return winner.id === rA.id ? -1 : 1;
          }
          return a.localeCompare(b);
        });

        // Strict 3-State Existence Matrix (`inIndex` x `inLocal` x `inRemote`)
        await this.taskPool.runAll(orderedPaths, async (path) => {
          await this.pathMutex.runExclusive(path, async () => {
            const indexEntry = this.index.files[path];
            const inIndex = Boolean(indexEntry);
            const inLocal = localByPath.has(path);
            const remoteMeta = remoteCanonicalByPath.get(path);
            const inRemote = Boolean(remoteMeta);

            // Case 1: New local file (inIndex=F, inLocal=T, inRemote=F)
            if (!inIndex && inLocal && !inRemote) {
              const bytes = await this.vault.readBinary(path);
              const localMd5 = md5Bytes(bytes);
              const sig = await this.uploadFileSilently(path, bytes, localMd5);
              if (sig) batchSignals.push(sig);
              return;
            }

            // Case 2: New remote file (inIndex=F, inLocal=F, inRemote=T)
            if (!inIndex && !inLocal && inRemote && remoteMeta) {
              await this.applyRemoteFileLocked(remoteMeta, path, undefined, batchSignals);
              return;
            }

            // Case 3: Dual-create (inIndex=F, inLocal=T, inRemote=T)
            if (!inIndex && inLocal && inRemote && remoteMeta) {
              await this.applyRemoteFileLocked(remoteMeta, path, undefined, batchSignals);
              return;
            }

            // Case 4: Exists in all three (inIndex=T, inLocal=T, inRemote=T)
            if (inIndex && inLocal && inRemote && remoteMeta) {
              const localBytes = await this.vault.readBinary(path);
              const localMd5 = md5Bytes(localBytes);
              const remoteMd5 = remoteMeta.md5Checksum ?? '';

              if (localMd5 === remoteMd5) {
                // Content converged — ensure index & base reflect canonical driveId
                const prevDriveId = indexEntry.driveId;
                this.index.files[path] = {
                  ...indexEntry,
                  driveId: remoteMeta.id,
                  md5: localMd5,
                  size: localBytes.byteLength,
                  modifiedTime: remoteMeta.modifiedTime,
                  createdTime: remoteMeta.createdTime,
                };
                if (prevDriveId !== remoteMeta.id) {
                  await this.vault.deleteBase(prevDriveId);
                }
                if (isTextSyncPath(path) && (await this.vault.readBase(remoteMeta.id)) === null) {
                  await this.vault.writeBase(remoteMeta.id, utf8Decoder.decode(localBytes));
                }
                return;
              }

              const localChanged = localMd5 !== indexEntry.md5;
              const remoteChanged = remoteMd5 !== indexEntry.md5;

              if (localChanged && !remoteChanged) {
                // Local changed, remote unchanged -> upload!
                const sig = await this.uploadFileSilently(
                  path,
                  localBytes,
                  localMd5,
                  { ...indexEntry, driveId: remoteMeta.id }
                );
                if (sig) batchSignals.push(sig);
                return;
              }

              // Either remote changed, both changed, or sibling overwrite -> delegate to applyRemoteFileLocked
              await this.applyRemoteFileLocked(remoteMeta, path, undefined, batchSignals);
              return;
            }

            // Case 5: Local deleted offline (inIndex=T, inLocal=F, inRemote=T)
            if (inIndex && !inLocal && inRemote && remoteMeta) {
              if (remoteMeta.md5Checksum === indexEntry.md5) {
                // Remote unchanged -> honor local offline delete!
                await this.drive.trashFile(remoteMeta.id);
                delete this.index.files[path];
                await this.vault.deleteBase(indexEntry.driveId);
                await this.vault.deletePrevBase(indexEntry.driveId);
                batchSignals.push({ id: remoteMeta.id, path, trashed: true });
                this.log('info', 'reconcile-delete', 'Trashed remotely (deleted locally offline)', path);
              } else {
                // Remote was edited while local deleted -> Edit-Wins-Over-Delete!
                await this.applyRemoteFileLocked(remoteMeta, path, undefined, batchSignals);
                this.log('info', 'edit-wins', 'Restored remotely edited file over local offline delete', path);
              }
              return;
            }

            // Case 6: Remote deleted offline (inIndex=T, inLocal=T, inRemote=F)
            if (inIndex && inLocal && !inRemote) {
              // Note: if this index entry is a local case-conflict alias whose driveId IS still live remotely, skip delete!
              if (
                this.vault.caseInsensitive &&
                driveIdToRemotePath.has(indexEntry.driveId)
              ) {
                const remotePath = driveIdToRemotePath.get(indexEntry.driveId)!;
                const liveMeta = remoteCanonicalByPath.get(remotePath);
                if (liveMeta) {
                  await this.applyRemoteFileLocked(liveMeta, path, undefined, batchSignals);
                  return;
                }
              }

              const localBytes = await this.vault.readBinary(path);
              const localMd5 = md5Bytes(localBytes);
              if (localMd5 === indexEntry.md5) {
                // Local unchanged -> honor remote delete!
                this.echoSuppressor.recordDelete(path);
                await this.vault.trashFile(path);
                delete this.index.files[path];
                await this.vault.deleteBase(indexEntry.driveId);
                await this.vault.deletePrevBase(indexEntry.driveId);
                this.log('info', 'reconcile-delete', 'Trashed locally (deleted remotely)', path);
              } else {
                // Local edited while remote deleted -> Edit-Wins-Over-Delete (re-upload)!
                const sig = await this.uploadFileSilently(path, localBytes, localMd5, indexEntry);
                if (sig) batchSignals.push(sig);
                this.log('info', 'edit-wins', 'Re-uploaded locally edited file over remote delete', path);
              }
              return;
            }

            // Case 7: Both deleted (inIndex=T, inLocal=F, inRemote=F)
            if (inIndex && !inLocal && !inRemote) {
              delete this.index.files[path];
              await this.vault.deleteBase(indexEntry.driveId);
              await this.vault.deletePrevBase(indexEntry.driveId);
            }
          });
        });

        // Set initial startPageToken (captured BEFORE inventory)
        if (!this.index.startPageToken) {
          this.index.startPageToken = tokenBefore;
        }
        await this.vault.saveIndex(this.index);

        // Emit ONE batched/throttled Firestore signal for the entire reconcile (P1 #2)
        if (batchSignals.length > 0) {
          await this.emitSignals(batchSignals, {
            requiresDeltaSync: batchSignals.length > 10,
            immediate: true,
          });
        }

        this.log(
          'info',
          'reconcile',
          `Reconciled ${orderedPaths.length} paths (${batchSignals.length} changes)`,
          undefined,
          this.now() - started
        );
      } catch (err) {
        opErr = err;
        throw err;
      } finally {
        this.endSyncOp(opErr);
      }
    };

    this.reconcilePromise = run().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  /**
   * Like `uploadFileLocked`, but collects outgoing signals into a batch instead of
   * emitting individually (so bulk initial sync emits 1 Firestore write instead of 3,000).
   */
  private async uploadFileSilently(
    path: string,
    localBytes: Uint8Array,
    localMd5: string,
    existingEntry?: FileIndexEntry
  ): Promise<OutgoingSignalItem | null> {
    const isText = isTextSyncPath(path);
    const mimeType = guessMimeType(path);

    if (existingEntry) {
      const remoteMeta = await this.drive.getFileMetadata(existingEntry.driveId);
      if (!remoteMeta) {
        const parentId = await this.ensureRemoteFolder(dirname(path));
        const created = await this.drive.createFile({
          name: basename(path),
          parentId,
          mimeType,
          content: localBytes,
          appProperties: { parentMd5: '', writer: this.settings.deviceId },
        });
        await this.vault.deleteBase(existingEntry.driveId);
        if (isText) {
          await this.vault.writeBase(created.id, utf8Decoder.decode(localBytes));
        }
        this.index.files[path] = {
          driveId: created.id,
          md5: localMd5,
          mtime: this.now(),
          size: localBytes.byteLength,
          isText,
          createdTime: created.createdTime,
          modifiedTime: created.modifiedTime,
        };
        return { id: created.id, path, md5: localMd5, parentMd5: '' };
      }

      if (remoteMeta.trashed) {
        const updated = await this.drive.updateFileContent(existingEntry.driveId, {
          mimeType,
          content: localBytes,
          trashed: false,
          appProperties: {
            parentMd5: existingEntry.md5,
            writer: this.settings.deviceId,
          },
        });
        if (isText) {
          await this.vault.writeBase(updated.id, utf8Decoder.decode(localBytes));
        }
        this.index.files[path] = {
          ...existingEntry,
          md5: localMd5,
          prevMd5: existingEntry.md5,
          mtime: this.now(),
          size: localBytes.byteLength,
          modifiedTime: updated.modifiedTime,
        };
        return { id: updated.id, path, md5: localMd5, parentMd5: existingEntry.md5 };
      }

      if (remoteMeta.md5Checksum && remoteMeta.md5Checksum !== existingEntry.md5) {
        const remoteBytes = await this.drive.downloadFile(remoteMeta.id);
        const baseText = isText ? await this.vault.readBase(existingEntry.driveId) : null;
        return this.resolveConflictOrMerge({
          path,
          driveId: remoteMeta.id,
          baseText,
          localBytes,
          remoteBytes,
          remoteMeta,
          deferSignal: true,
        });
      }

      const prevMd5 = existingEntry.md5;
      if (isText) {
        const oldBase = await this.vault.readBase(existingEntry.driveId);
        if (oldBase !== null) {
          await this.vault.writePrevBase(existingEntry.driveId, oldBase);
        }
      }

      const updated = await this.drive.updateFileContent(existingEntry.driveId, {
        mimeType,
        content: localBytes,
        appProperties: { parentMd5: prevMd5, writer: this.settings.deviceId },
      });
      if (isText) {
        await this.vault.writeBase(existingEntry.driveId, utf8Decoder.decode(localBytes));
      }
      this.index.files[path] = {
        ...existingEntry,
        md5: localMd5,
        prevMd5,
        mtime: this.now(),
        size: localBytes.byteLength,
        modifiedTime: updated.modifiedTime,
      };
      return { id: updated.id, path, md5: localMd5, parentMd5: prevMd5 };
    }

    const parentId = await this.ensureRemoteFolder(dirname(path));
    const created = await this.drive.createFile({
      name: basename(path),
      parentId,
      mimeType,
      content: localBytes,
      appProperties: { parentMd5: '', writer: this.settings.deviceId },
    });
    if (isText) {
      await this.vault.writeBase(created.id, utf8Decoder.decode(localBytes));
    }
    this.index.files[path] = {
      driveId: created.id,
      md5: localMd5,
      mtime: this.now(),
      size: localBytes.byteLength,
      isText,
      createdTime: created.createdTime,
      modifiedTime: created.modifiedTime,
    };
    return { id: created.id, path, md5: localMd5, parentMd5: '' };
  }

  /**
   * Applies an incoming remote file update/create to the local vault, enforcing:
   * - APFS case-collision disambiguation (`<Name> (case-conflict <shortId>).<ext>`)
   * - Active editor 1.5s remote-write deferral
   * - Layer-2 sibling-overwrite (`parentMd5 === prevMd5`) recovery via `prevBase`
   * - 3-way merge & `.canvas`/`.json` validation fallback
   */
  private async applyRemoteFileLocked(
    remoteMeta: DriveFileMetadata,
    targetPath: string,
    preDownloadedBytes?: Uint8Array,
    batchSignals?: OutgoingSignalItem[]
  ): Promise<void> {
    let localPath = normalizePath(targetPath);

    // APFS case-collision check (different driveId sharing foldPath)
    const collision = this.findCaseCollision(localPath, remoteMeta.id);
    if (collision) {
      const disambiguated = buildCaseConflictPath(localPath, remoteMeta.id);
      this.log(
        'warn',
        'case-collision',
        `APFS case collision with ${collision.existingPath}; storing as ${disambiguated}`,
        localPath
      );
      localPath = disambiguated;
    }

    // Active editor 1.5s deferral so we don't interrupt active typing
    if (this.vault.isActiveEditorFile(localPath) && this.activeEditorDeferMs > 0) {
      const lastEdit = this.vault.getLastActiveEditTime(localPath);
      const elapsed = this.now() - lastEdit;
      if (lastEdit > 0 && elapsed < this.activeEditorDeferMs) {
        await this.sleep(this.activeEditorDeferMs - elapsed);
      }
    }

    const existingEntry = this.index.files[localPath];
    // Guard: if a DIFFERENT driveId arrives at a path already tracked by a live driveId,
    // verify remote is not a stale trashed loser before touching local state!
    if (existingEntry && existingEntry.driveId !== remoteMeta.id) {
      const freshRemote = await this.drive.getFileMetadata(remoteMeta.id);
      if (!freshRemote || freshRemote.trashed) {
        return;
      }
    }

    const localExists = await this.vault.exists(localPath);
    const isText = isTextSyncPath(localPath);

    if (!localExists) {
      // Check if this was a local offline delete of an unchanged file
      if (
        existingEntry &&
        existingEntry.driveId === remoteMeta.id &&
        remoteMeta.md5Checksum &&
        remoteMeta.md5Checksum === existingEntry.md5
      ) {
        return;
      }

      const remoteBytes =
        preDownloadedBytes ?? (await this.drive.downloadFile(remoteMeta.id));
      const remoteMd5 = remoteMeta.md5Checksum || md5Bytes(remoteBytes);

      await this.writeLocalEchoSuppressed(localPath, remoteBytes);
      if (isText) {
        await this.vault.writeBase(remoteMeta.id, utf8Decoder.decode(remoteBytes));
      }
      this.index.files[localPath] = {
        driveId: remoteMeta.id,
        md5: remoteMd5,
        mtime: this.now(),
        size: remoteBytes.byteLength,
        isText,
        createdTime: remoteMeta.createdTime,
        modifiedTime: remoteMeta.modifiedTime,
      };
      this.log('info', 'download', `Downloaded (${remoteBytes.byteLength} B)`, localPath);
      return;
    }

    // Local file exists: read bytes & compare MD5
    const localBytes = await this.vault.readBinary(localPath);
    const localMd5 = md5Bytes(localBytes);
    const remoteMd5Hint = remoteMeta.md5Checksum;

    const adoptIdenticalContentMeta = async (md5: string): Promise<void> => {
      let chosenId = remoteMeta.id;
      let chosenCreated = remoteMeta.createdTime ?? existingEntry?.createdTime;
      let chosenModified = remoteMeta.modifiedTime ?? existingEntry?.modifiedTime;

      if (existingEntry && existingEntry.driveId !== remoteMeta.id) {
        // Two different driveIds at the same path with identical content (e.g. concurrent
        // conflict-copy race): deterministically elect canonical winner & trash loser so
        // a loser's later trash event never deletes the canonical winner locally!
        const existingMeta = await this.drive.getFileMetadata(existingEntry.driveId);
        if (existingMeta && !existingMeta.trashed) {
          const incomingMeta =
            remoteMeta.createdTime
              ? remoteMeta
              : (await this.drive.getFileMetadata(remoteMeta.id)) ?? remoteMeta;
          const { winner, losers } = electCanonical([existingMeta, incomingMeta]);
          chosenId = winner.id;
          chosenCreated = winner.createdTime;
          chosenModified = winner.modifiedTime;
          for (const loser of losers) {
            await this.drive.trashFile(loser.id);
          }
        }
      }

      this.index.files[localPath] = {
        ...existingEntry,
        driveId: chosenId,
        md5,
        mtime: this.now(),
        size: localBytes.byteLength,
        isText,
        createdTime: chosenCreated,
        modifiedTime: chosenModified,
      };
      if (isText && (await this.vault.readBase(chosenId)) === null) {
        await this.vault.writeBase(chosenId, utf8Decoder.decode(localBytes));
      }
    };

    if (remoteMd5Hint && localMd5 === remoteMd5Hint) {
      // Identical content -> 0-byte no-op (preserving canonical driveId on duplicate races)!
      await adoptIdenticalContentMeta(localMd5);
      return;
    }

    // Layer-2 Sibling Overwrite Race Check (TOCTOU guard!)
    const remoteParentMd5 = remoteMeta.appProperties?.parentMd5;
    const remoteWriter = remoteMeta.appProperties?.writer;
    const isSiblingOverwrite = Boolean(
      existingEntry &&
        existingEntry.prevMd5 &&
        remoteParentMd5 &&
        remoteParentMd5 === existingEntry.prevMd5 &&
        remoteMd5Hint !== existingEntry.md5 &&
        remoteWriter !== this.settings.deviceId
    );

    const remoteBytes =
      preDownloadedBytes ?? (await this.drive.downloadFile(remoteMeta.id));
    const remoteMd5 = remoteMd5Hint || md5Bytes(remoteBytes);

    if (localMd5 === remoteMd5) {
      await adoptIdenticalContentMeta(localMd5);
      return;
    }

    if (!isSiblingOverwrite && existingEntry && localMd5 === existingEntry.md5) {
      // Local unchanged -> fast clean pull!
      await this.writeLocalEchoSuppressed(localPath, remoteBytes);
      if (isText) {
        await this.vault.writeBase(remoteMeta.id, utf8Decoder.decode(remoteBytes));
      }
      await this.vault.deletePrevBase(remoteMeta.id);
      this.index.files[localPath] = {
        driveId: remoteMeta.id,
        md5: remoteMd5,
        mtime: this.now(),
        size: remoteBytes.byteLength,
        isText,
        createdTime: remoteMeta.createdTime,
        modifiedTime: remoteMeta.modifiedTime,
      };
      this.log('info', 'download', `Updated from remote (${remoteBytes.byteLength} B)`, localPath);
      return;
    }

    // Concurrent edit, dual-create, OR Layer-2 sibling-overwrite detected!
    let baseText: string | null = null;
    if (isText) {
      if (isSiblingOverwrite && existingEntry) {
        baseText = await this.vault.readPrevBase(existingEntry.driveId);
        this.log(
          'warn',
          'sibling-race',
          `Detected TOCTOU sibling overwrite (parentMd5=${remoteParentMd5}); merging with prevBase`,
          localPath
        );
      } else if (existingEntry) {
        // If base snapshot is missing on disk, keep `null` -> conservative conflict copy (NEVER pass "")!
        baseText = await this.vault.readBase(existingEntry.driveId);
      } else {
        // True dual-create (neither existed in index before) -> empty base
        baseText = '';
      }
    }

    const sig = await this.resolveConflictOrMerge({
      path: localPath,
      driveId: remoteMeta.id,
      baseText,
      localBytes,
      remoteBytes,
      remoteMeta,
      deferSignal: Boolean(batchSignals),
    });
    if (sig && batchSignals) {
      batchSignals.push(sig);
    }
  }

  /**
   * Resolves a concurrent edit (3-way auto-merge or safe conflict copy).
   * Guarantees zero data loss, valid JSON at canonical `.canvas`/`.json`,
   * Android-safe conflict filenames, and zero conflict-of-conflict loops.
   */
  private async resolveConflictOrMerge(params: {
    path: string;
    driveId: string;
    baseText: string | null;
    localBytes: Uint8Array;
    remoteBytes: Uint8Array;
    remoteMeta: DriveFileMetadata;
    deferSignal?: boolean;
  }): Promise<OutgoingSignalItem | null> {
    const { path, driveId, baseText, localBytes, remoteBytes, remoteMeta, deferSignal } = params;
    const isText = isTextSyncPath(path);
    const isJson = isJsonPath(path);
    const remoteMd5 = remoteMeta.md5Checksum || md5Bytes(remoteBytes);

    if (isText) {
      const localText = utf8Decoder.decode(localBytes);
      const remoteText = utf8Decoder.decode(remoteBytes);

      const mergedRes = merge3(baseText, localText, remoteText, {
        path,
        validateJson: isJson,
      });

      if (mergedRes.status === 'clean' && mergedRes.merged !== undefined) {
        const mergedBytes = utf8Encoder.encode(mergedRes.merged);
        const mergedMd5 = md5Bytes(mergedBytes);

        // Write merged locally (echo-suppressed)
        await this.writeLocalEchoSuppressed(path, mergedBytes);

        // Upload merged back to Drive (only if different from remote)
        let finalModifiedTime = remoteMeta.modifiedTime;
        if (mergedMd5 !== remoteMd5) {
          const updated = await this.drive.updateFileContent(driveId, {
            mimeType: guessMimeType(path),
            content: mergedBytes,
            appProperties: {
              parentMd5: remoteMd5,
              writer: this.settings.deviceId,
            },
          });
          finalModifiedTime = updated.modifiedTime;
        }

        await this.vault.writeBase(driveId, mergedRes.merged);
        await this.vault.deletePrevBase(driveId);

        this.index.files[path] = {
          driveId,
          md5: mergedMd5,
          mtime: this.now(),
          size: mergedBytes.byteLength,
          isText: true,
          createdTime: remoteMeta.createdTime,
          modifiedTime: finalModifiedTime,
        };
        await this.vault.saveIndex(this.index);

        const sig: OutgoingSignalItem = {
          id: driveId,
          path,
          md5: mergedMd5,
          parentMd5: remoteMd5,
        };
        if (!deferSignal && mergedMd5 !== remoteMd5) {
          await this.emitSignals([sig]);
        }
        this.log('info', 'auto-merge', 'Clean 3-way merge succeeded', path);
        return mergedMd5 !== remoteMd5 ? sig : null;
      }

      // Text conflict (overlap, missing-base, size-limit, or invalid-json for .canvas/.json)
      const reason = mergedRes.reason ?? 'overlap';
      const conflictPath = buildConflictPath(
        path,
        this.settings.deviceName,
        new Date(this.now())
      );

      // For .canvas/.json, guarantee canonical path holds valid JSON!
      let keepRemoteAtCanonical = true;
      if (isJson) {
        const remoteValid = isValidJsonString(remoteText);
        const localValid = isValidJsonString(localText);
        if (!remoteValid && localValid) {
          keepRemoteAtCanonical = false;
        } else {
          keepRemoteAtCanonical = true;
        }
      }

      if (keepRemoteAtCanonical) {
        // Keep remote at canonical path (0 re-upload of canonical -> zero conflict-of-conflict loops!)
        // Save local version as conflict copy and upload the conflict copy.
        await this.writeLocalEchoSuppressed(path, remoteBytes);
        await this.vault.writeBase(driveId, remoteText);
        await this.vault.deletePrevBase(driveId);
        this.index.files[path] = {
          driveId,
          md5: remoteMd5,
          mtime: this.now(),
          size: remoteBytes.byteLength,
          isText: true,
          createdTime: remoteMeta.createdTime,
          modifiedTime: remoteMeta.modifiedTime,
        };

        const conflictSig = await this.writeAndUploadConflictCopy(conflictPath, localBytes);
        await this.vault.saveIndex(this.index);
        this.recordConflict(path, conflictPath, reason);
        if (!deferSignal && conflictSig) {
          await this.emitSignals([conflictSig]);
        }
        return conflictSig;
      } else {
        // Keep valid local JSON at canonical, upload it, and save invalid remote as conflict copy
        const localMd5 = md5Bytes(localBytes);
        const updated = await this.drive.updateFileContent(driveId, {
          mimeType: guessMimeType(path),
          content: localBytes,
          appProperties: {
            parentMd5: remoteMd5,
            writer: this.settings.deviceId,
          },
        });
        await this.vault.writeBase(driveId, localText);
        await this.vault.deletePrevBase(driveId);
        this.index.files[path] = {
          driveId,
          md5: localMd5,
          mtime: this.now(),
          size: localBytes.byteLength,
          isText: true,
          createdTime: remoteMeta.createdTime,
          modifiedTime: updated.modifiedTime,
        };
        const conflictSig = await this.writeAndUploadConflictCopy(conflictPath, remoteBytes);
        await this.vault.saveIndex(this.index);
        this.recordConflict(path, conflictPath, reason);
        const sigs: OutgoingSignalItem[] = [
          { id: driveId, path, md5: localMd5, parentMd5: remoteMd5 },
          ...(conflictSig ? [conflictSig] : []),
        ];
        if (!deferSignal) {
          await this.emitSignals(sigs);
        }
        return sigs[0];
      }
    }

    // Binary conflict: keep remote at canonical path, save local as conflict copy & upload it
    const conflictPath = buildConflictPath(
      path,
      this.settings.deviceName,
      new Date(this.now())
    );
    await this.writeLocalEchoSuppressed(path, remoteBytes);
    this.index.files[path] = {
      driveId,
      md5: remoteMd5,
      mtime: this.now(),
      size: remoteBytes.byteLength,
      isText: false,
      createdTime: remoteMeta.createdTime,
      modifiedTime: remoteMeta.modifiedTime,
    };

    const conflictSig = await this.writeAndUploadConflictCopy(conflictPath, localBytes);
    await this.vault.saveIndex(this.index);
    this.recordConflict(path, conflictPath, 'binary-conflict');
    if (!deferSignal && conflictSig) {
      await this.emitSignals([conflictSig]);
    }
    return conflictSig;
  }

  private async writeAndUploadConflictCopy(
    conflictPath: string,
    bytes: Uint8Array
  ): Promise<OutgoingSignalItem> {
    const md5 = md5Bytes(bytes);
    const isText = isTextSyncPath(conflictPath);

    await this.writeLocalEchoSuppressed(conflictPath, bytes);
    const parentId = await this.ensureRemoteFolder(dirname(conflictPath));
    const created = await this.drive.createFile({
      name: basename(conflictPath),
      parentId,
      mimeType: guessMimeType(conflictPath),
      content: bytes,
      appProperties: {
        parentMd5: '',
        writer: this.settings.deviceId,
      },
    });
    if (isText) {
      await this.vault.writeBase(created.id, utf8Decoder.decode(bytes));
    }
    this.index.files[conflictPath] = {
      driveId: created.id,
      md5,
      mtime: this.now(),
      size: bytes.byteLength,
      isText,
      createdTime: created.createdTime,
      modifiedTime: created.modifiedTime,
    };
    return {
      id: created.id,
      path: conflictPath,
      md5,
      parentMd5: '',
    };
  }

  private async writeLocalEchoSuppressed(
    path: string,
    bytes: Uint8Array
  ): Promise<void> {
    const md5 = md5Bytes(bytes);
    this.echoSuppressor.recordWrite(path, md5);
    if (isTextSyncPath(path)) {
      const text = utf8Decoder.decode(bytes);
      // Verify text round-trip matches exact md5; if invalid UTF-8 bytes exist, fall back to binary write
      if (md5String(text) === md5) {
        await this.vault.writeText(path, text);
        return;
      }
    }
    await this.vault.writeBinary(path, bytes);
  }
}
