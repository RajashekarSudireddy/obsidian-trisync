import { describe, expect, it } from 'vitest';
import { md5Bytes } from '../src/crypto/md5';
import type {
  CreateFileParams,
  IRemoteDriveClient,
  UpdateFileContentParams,
  UpdateFileMetadataParams,
} from '../src/drive/driveClient';
import {
  SignalBatcher,
  type ISignalBus,
  type OutgoingSignalItem,
  type PublishSignalOptions,
} from '../src/signal/firestoreSignal';
import {
  basename,
  dirname,
  foldPath,
  normalizePath,
} from '../src/sync/ignore';
import { SyncEngine } from '../src/sync/syncEngine';
import {
  ObsidianVaultAdapter,
  type IVaultAdapter,
  type VaultFileInfo,
} from '../src/sync/vaultStore';
import {
  DEFAULT_SETTINGS,
  DRIVE_FOLDER_MIME,
  createEmptySyncIndex,
  type DriveChange,
  type DriveChangesPage,
  type DriveFileMetadata,
  type SignalDocument,
  type SyncIndex,
  type TriSyncSettings,
} from '../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ============================================================================
// In-Memory Google Drive v3 Server Simulator (Object-ID semantics + changes.list)
// ============================================================================

interface StoredDriveItem {
  meta: DriveFileMetadata;
  content: Uint8Array;
  removed: boolean;
}

class MockGoogleDriveServer {
  private nextId = 1;
  private nextTimeMs = Date.parse('2026-11-19T10:00:00.000Z');
  private readonly items = new Map<string, StoredDriveItem>();
  private readonly changeLog: Array<{ token: number; change: DriveChange }> = [];
  private changeSeq = 0;

  // Counters for verifying P0/P1 invariants
  stats = {
    createFile: 0,
    createFolder: 0,
    updateContent: 0,
    updateMetadata: 0,
    trash: 0,
    download: 0,
    getMetadata: 0,
    listAll: 0,
    listChanges: 0,
  };

  resetStats(): void {
    for (const k of Object.keys(this.stats) as Array<keyof typeof this.stats>) {
      this.stats[k] = 0;
    }
  }

  private allocId(prefix: string): string {
    return `${prefix}_${String(this.nextId++).padStart(4, '0')}`;
  }

  private nextIsoTime(): string {
    this.nextTimeMs += 1000;
    return new Date(this.nextTimeMs).toISOString();
  }

  private recordChange(fileId: string, removed = false): void {
    this.changeSeq += 1;
    const item = this.items.get(fileId);
    const change: DriveChange = removed
      ? { fileId, removed: true } // Drive omits `file` when `removed === true`!
      : {
          fileId,
          removed: false,
          file: item ? this.cloneMeta(item.meta) : undefined,
        };
    this.changeLog.push({ token: this.changeSeq, change });
  }

  private cloneMeta(meta: DriveFileMetadata): DriveFileMetadata {
    return {
      ...meta,
      parents: meta.parents ? [...meta.parents] : undefined,
      appProperties: meta.appProperties ? { ...meta.appProperties } : undefined,
    };
  }

  createRootFolder(name: string): string {
    const id = this.allocId('root');
    const ts = this.nextIsoTime();
    this.items.set(id, {
      meta: {
        id,
        name,
        mimeType: DRIVE_FOLDER_MIME,
        parents: ['root'],
        trashed: false,
        createdTime: ts,
        modifiedTime: ts,
      },
      content: new Uint8Array(0),
      removed: false,
    });
    this.recordChange(id, false);
    return id;
  }

  /**
   * Simulates permanent deletion (emptying Drive trash -> `removed: true` + `404` on GET/PATCH).
   */
  permanentlyRemoveFile(fileId: string): void {
    const item = this.items.get(fileId);
    if (!item) return;
    item.removed = true;
    this.recordChange(fileId, true);
  }

  getRawItem(fileId: string): StoredDriveItem | undefined {
    return this.items.get(fileId);
  }

  listLiveItems(): DriveFileMetadata[] {
    const out: DriveFileMetadata[] = [];
    for (const item of this.items.values()) {
      if (!item.removed && !item.meta.trashed) {
        out.push(this.cloneMeta(item.meta));
      }
    }
    return out;
  }

  createClientForDevice(deviceId: string): MockDriveDeviceClient {
    return new MockDriveDeviceClient(this, deviceId);
  }

  // Internal server operations called by MockDriveDeviceClient
  _ensureVaultRoot(vaultName: string, existingRootId?: string): string {
    if (existingRootId) {
      const ex = this.items.get(existingRootId);
      if (ex && !ex.removed && !ex.meta.trashed) {
        return ex.meta.id;
      }
    }
    return this.createRootFolder(vaultName);
  }

  _listAll(): DriveFileMetadata[] {
    this.stats.listAll++;
    return this.listLiveItems();
  }

  _getStartPageToken(): string {
    return String(this.changeSeq + 1);
  }

  _listChanges(pageToken: string): DriveChangesPage {
    this.stats.listChanges++;
    const fromToken = Number(pageToken) || 1;
    const matched = this.changeLog
      .filter((entry) => entry.token >= fromToken)
      .map((entry) => ({
        fileId: entry.change.fileId,
        removed: entry.change.removed,
        file: entry.change.file ? this.cloneMeta(entry.change.file) : undefined,
      }));
    return {
      changes: matched,
      newStartPageToken: String(this.changeSeq + 1),
    };
  }

  _getFileMetadata(fileId: string): DriveFileMetadata | null {
    this.stats.getMetadata++;
    const item = this.items.get(fileId);
    if (!item || item.removed) return null;
    return this.cloneMeta(item.meta);
  }

  _downloadFile(fileId: string): Uint8Array {
    this.stats.download++;
    const item = this.items.get(fileId);
    if (!item || item.removed) {
      const err = new Error(`404 Not Found: ${fileId}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return new Uint8Array(item.content);
  }

  _findFolderByName(name: string, parentId: string): DriveFileMetadata | null {
    const matches: DriveFileMetadata[] = [];
    for (const item of this.items.values()) {
      if (
        !item.removed &&
        !item.meta.trashed &&
        item.meta.mimeType === DRIVE_FOLDER_MIME &&
        item.meta.name === name &&
        item.meta.parents?.includes(parentId)
      ) {
        matches.push(this.cloneMeta(item.meta));
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''));
    return matches[0];
  }

  _createFolder(name: string, parentId: string): DriveFileMetadata {
    this.stats.createFolder++;
    const id = this.allocId('fld');
    const ts = this.nextIsoTime();
    const meta: DriveFileMetadata = {
      id,
      name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
      trashed: false,
      createdTime: ts,
      modifiedTime: ts,
    };
    this.items.set(id, { meta, content: new Uint8Array(0), removed: false });
    this.recordChange(id, false);
    return this.cloneMeta(meta);
  }

  _createFile(params: CreateFileParams): DriveFileMetadata {
    this.stats.createFile++;
    const id = this.allocId('file');
    const ts = this.nextIsoTime();
    const bytes = new Uint8Array(params.content);
    const meta: DriveFileMetadata = {
      id,
      name: params.name,
      mimeType: params.mimeType,
      parents: [params.parentId],
      md5Checksum: md5Bytes(bytes),
      size: String(bytes.byteLength),
      trashed: false,
      createdTime: ts,
      modifiedTime: ts,
      appProperties: params.appProperties ? { ...params.appProperties } : undefined,
    };
    this.items.set(id, { meta, content: bytes, removed: false });
    this.recordChange(id, false);
    return this.cloneMeta(meta);
  }

  _updateFileContent(fileId: string, params: UpdateFileContentParams): DriveFileMetadata {
    this.stats.updateContent++;
    const item = this.items.get(fileId);
    if (!item || item.removed) {
      const err = new Error(`404 Not Found: ${fileId}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    const bytes = new Uint8Array(params.content);
    item.content = bytes;
    item.meta.md5Checksum = md5Bytes(bytes);
    item.meta.size = String(bytes.byteLength);
    item.meta.mimeType = params.mimeType;
    item.meta.modifiedTime = this.nextIsoTime();
    if (typeof params.trashed === 'boolean') {
      item.meta.trashed = params.trashed;
    }
    if (params.name) {
      item.meta.name = params.name;
    }
    if (params.appProperties) {
      item.meta.appProperties = {
        ...(item.meta.appProperties ?? {}),
        ...params.appProperties,
      };
    }
    this.recordChange(fileId, false);
    return this.cloneMeta(item.meta);
  }

  _updateFileMetadata(fileId: string, params: UpdateFileMetadataParams): DriveFileMetadata {
    this.stats.updateMetadata++;
    const item = this.items.get(fileId);
    if (!item || item.removed) {
      const err = new Error(`404 Not Found: ${fileId}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    if (params.name !== undefined) item.meta.name = params.name;
    if (params.trashed !== undefined) item.meta.trashed = params.trashed;
    if (params.appProperties) {
      item.meta.appProperties = {
        ...(item.meta.appProperties ?? {}),
        ...params.appProperties,
      };
    }
    if (params.addParents || params.removeParents) {
      const set = new Set(item.meta.parents ?? []);
      for (const r of params.removeParents ?? []) set.delete(r);
      for (const a of params.addParents ?? []) set.add(a);
      item.meta.parents = Array.from(set);
    }
    item.meta.modifiedTime = this.nextIsoTime();
    this.recordChange(fileId, false);
    return this.cloneMeta(item.meta);
  }

  _trashFile(fileId: string): DriveFileMetadata | null {
    this.stats.trash++;
    const item = this.items.get(fileId);
    if (!item || item.removed) return null;
    item.meta.trashed = true;
    item.meta.modifiedTime = this.nextIsoTime();
    this.recordChange(fileId, false);
    return this.cloneMeta(item.meta);
  }
}

class MockDriveDeviceClient implements IRemoteDriveClient {
  offline = false;
  simulateConcurrentBlindFolderCreate = false;
  beforeUpdateContent?: (fileId: string, params: UpdateFileContentParams) => Promise<void>;

  constructor(
    private readonly server: MockGoogleDriveServer,
    public readonly deviceId: string
  ) {}

  private checkOnline(): void {
    if (this.offline) {
      throw new Error('Network offline');
    }
  }

  async ensureVaultRootFolder(vaultName: string, existingRootId?: string): Promise<string> {
    this.checkOnline();
    return this.server._ensureVaultRoot(vaultName, existingRootId);
  }

  async listAllItems(): Promise<DriveFileMetadata[]> {
    this.checkOnline();
    return this.server._listAll();
  }

  async getStartPageToken(): Promise<string> {
    this.checkOnline();
    return this.server._getStartPageToken();
  }

  async listChanges(pageToken: string): Promise<DriveChangesPage> {
    this.checkOnline();
    return this.server._listChanges(pageToken);
  }

  async getFileMetadata(fileId: string): Promise<DriveFileMetadata | null> {
    this.checkOnline();
    return this.server._getFileMetadata(fileId);
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    this.checkOnline();
    return this.server._downloadFile(fileId);
  }

  async findFolderByName(name: string, parentId: string): Promise<DriveFileMetadata | null> {
    this.checkOnline();
    if (this.simulateConcurrentBlindFolderCreate) {
      return null;
    }
    return this.server._findFolderByName(name, parentId);
  }

  async createFolder(name: string, parentId: string): Promise<DriveFileMetadata> {
    this.checkOnline();
    return this.server._createFolder(name, parentId);
  }

  async createFile(params: CreateFileParams): Promise<DriveFileMetadata> {
    this.checkOnline();
    return this.server._createFile(params);
  }

  async updateFileContent(
    fileId: string,
    params: UpdateFileContentParams
  ): Promise<DriveFileMetadata> {
    this.checkOnline();
    if (this.beforeUpdateContent) {
      await this.beforeUpdateContent(fileId, params);
    }
    return this.server._updateFileContent(fileId, params);
  }

  async updateFileMetadata(
    fileId: string,
    params: UpdateFileMetadataParams
  ): Promise<DriveFileMetadata> {
    this.checkOnline();
    return this.server._updateFileMetadata(fileId, params);
  }

  async trashFile(fileId: string): Promise<DriveFileMetadata | null> {
    this.checkOnline();
    return this.server._trashFile(fileId);
  }
}

// ============================================================================
// In-Memory Firestore Signal Hub (with real SignalBatcher + outage/drop controls)
// ============================================================================

class MockFirestoreSignalHub {
  offline = false;
  dropPulses = false;
  writeCount = 0;
  lastDoc: SignalDocument | null = null;
  private readonly devices = new Map<string, MockDeviceSignalBus>();

  createBus(deviceId: string, minIntervalMs = 0): MockDeviceSignalBus {
    const bus = new MockDeviceSignalBus(this, deviceId, minIntervalMs);
    this.devices.set(deviceId, bus);
    return bus;
  }

  async broadcast(doc: SignalDocument): Promise<void> {
    if (this.offline) return;
    this.writeCount++;
    this.lastDoc = JSON.parse(JSON.stringify(doc)) as SignalDocument;

    // Keep all batchers' sequence counters synchronized just like Firestore onSnapshot
    for (const bus of this.devices.values()) {
      bus._observeDoc(this.lastDoc);
    }

    if (this.dropPulses) return;

    const deliveries: Promise<void>[] = [];
    for (const bus of this.devices.values()) {
      if (bus.deviceId !== doc.sender && bus.isConnected()) {
        deliveries.push(bus._deliver(this.lastDoc));
      }
    }
    await Promise.all(deliveries);
  }
}

class MockDeviceSignalBus implements ISignalBus {
  private connected = true;
  private readonly handlers = new Set<(doc: SignalDocument) => void>();
  private readonly batcher: SignalBatcher;

  constructor(
    private readonly hub: MockFirestoreSignalHub,
    public readonly deviceId: string,
    minIntervalMs = 0
  ) {
    this.batcher = new SignalBatcher(
      deviceId,
      async (doc) => {
        await this.hub.broadcast(doc);
      },
      { minIntervalMs }
    );
  }

  setConnected(v: boolean): void {
    this.connected = v;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.batcher.dispose();
  }

  async reconnectNetwork(): Promise<void> {
    this.connected = true;
  }

  async publishChanges(
    items: OutgoingSignalItem[],
    options?: PublishSignalOptions
  ): Promise<void> {
    if (!this.connected || this.hub.offline) return;
    await this.batcher.enqueue(items, options);
  }

  async flushPendingSignals(): Promise<void> {
    if (!this.connected || this.hub.offline) return;
    await this.batcher.flush();
  }

  subscribe(handler: (doc: SignalDocument) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  isConnected(): boolean {
    return this.connected && !this.hub.offline;
  }

  _observeDoc(doc: SignalDocument): void {
    this.batcher.observeRemoteDocument(doc);
  }

  async _deliver(doc: SignalDocument): Promise<void> {
    for (const h of this.handlers) {
      await Promise.resolve(h(doc));
    }
  }
}

// ============================================================================
// In-Memory Vault Simulator (APFS Case-Insensitive & Android Case-Sensitive)
// ============================================================================

class MockVaultAdapter implements IVaultAdapter {
  readonly caseInsensitive: boolean;
  private readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  private readonly folders = new Set<string>();
  private readonly trashed = new Map<string, Uint8Array>();
  private index: SyncIndex = createEmptySyncIndex();
  private readonly bases = new Map<string, string>();
  private readonly prevBases = new Map<string, string>();
  private clock = Date.parse('2026-11-19T10:00:00.000Z');

  // Optional watcher hook simulating Obsidian vault events firing back into SyncEngine
  onMutation?: (
    kind: 'write' | 'delete' | 'rename',
    path: string,
    oldPath?: string,
    isFolder?: boolean
  ) => void;

  constructor(options: { caseInsensitive: boolean }) {
    this.caseInsensitive = options.caseInsensitive;
  }

  private resolveKey(rawPath: string): string | null {
    const norm = normalizePath(rawPath);
    if (this.files.has(norm)) return norm;
    if (this.caseInsensitive) {
      const folded = foldPath(norm);
      for (const k of this.files.keys()) {
        if (foldPath(k) === folded) return k;
      }
    }
    return null;
  }

  private resolveFolderKey(rawPath: string): string | null {
    const norm = normalizePath(rawPath);
    if (this.folders.has(norm)) return norm;
    if (this.caseInsensitive) {
      const folded = foldPath(norm);
      for (const k of this.folders.values()) {
        if (foldPath(k) === folded) return k;
      }
    }
    return null;
  }

  /**
   * Direct user edit (bypasses SyncEngine echo suppression, like user typing in Obsidian).
   */
  userWriteText(rawPath: string, content: string): void {
    const norm = normalizePath(rawPath);
    const parent = dirname(norm);
    if (parent) this.addFolderRecursive(parent);
    const existingKey = this.resolveKey(norm);
    if (existingKey && existingKey !== norm) {
      this.files.delete(existingKey);
    }
    this.files.set(norm, { bytes: enc.encode(content), mtime: ++this.clock });
  }

  userWriteBinary(rawPath: string, data: Uint8Array): void {
    const norm = normalizePath(rawPath);
    const parent = dirname(norm);
    if (parent) this.addFolderRecursive(parent);
    const existingKey = this.resolveKey(norm);
    if (existingKey && existingKey !== norm) {
      this.files.delete(existingKey);
    }
    this.files.set(norm, { bytes: new Uint8Array(data), mtime: ++this.clock });
  }

  userDelete(rawPath: string): void {
    const key = this.resolveKey(rawPath);
    if (key) this.files.delete(key);
  }

  userRename(rawOldPath: string, rawNewPath: string, isFolder = false): void {
    const oldNorm = normalizePath(rawOldPath);
    const newNorm = normalizePath(rawNewPath);
    if (isFolder) {
      const oldPrefix = oldNorm + '/';
      const newPrefix = newNorm + '/';
      const toMove: Array<[string, { bytes: Uint8Array; mtime: number }]> = [];
      for (const [k, v] of this.files.entries()) {
        if (k.startsWith(oldPrefix)) {
          toMove.push([k, v]);
        }
      }
      for (const [k, v] of toMove) {
        this.files.delete(k);
        this.files.set(newPrefix + k.slice(oldPrefix.length), v);
      }
      const nextFolders = new Set<string>();
      for (const f of this.folders) {
        if (f === oldNorm) nextFolders.add(newNorm);
        else if (f.startsWith(oldPrefix)) nextFolders.add(newPrefix + f.slice(oldPrefix.length));
        else nextFolders.add(f);
      }
      nextFolders.add(newNorm);
      this.folders.clear();
      for (const f of nextFolders) this.folders.add(f);
      return;
    }
    const key = this.resolveKey(oldNorm);
    if (!key) return;
    const val = this.files.get(key)!;
    this.files.delete(key);
    const parent = dirname(newNorm);
    if (parent) this.addFolderRecursive(parent);
    this.files.set(newNorm, val);
  }

  getSnapshotTextMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.files.entries()) {
      out[k] = dec.decode(v.bytes);
    }
    return out;
  }

  getAllPaths(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  getRawBytes(rawPath: string): Uint8Array | undefined {
    const key = this.resolveKey(rawPath);
    return key ? this.files.get(key)?.bytes : undefined;
  }

  getTrashedPaths(): string[] {
    return Array.from(this.trashed.keys());
  }

  getBaseIds(): string[] {
    return Array.from(this.bases.keys()).sort();
  }

  private addFolderRecursive(folderPath: string): void {
    const parts = normalizePath(folderPath).split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      this.folders.add(cur);
    }
  }

  async listFiles(): Promise<VaultFileInfo[]> {
    return Array.from(this.files.entries()).map(([p, v]) => ({
      path: p,
      rawPath: p,
      mtime: v.mtime,
      size: v.bytes.byteLength,
    }));
  }

  async listFolders(): Promise<string[]> {
    return Array.from(this.folders);
  }

  async exists(path: string): Promise<boolean> {
    return Boolean(this.resolveKey(path) || this.resolveFolderKey(path));
  }

  async findExistingPath(path: string): Promise<string | null> {
    return this.resolveKey(path) ?? this.resolveFolderKey(path);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const key = this.resolveKey(path);
    if (!key) throw new Error(`ENOENT: ${path}`);
    return new Uint8Array(this.files.get(key)!.bytes);
  }

  async readText(path: string): Promise<string> {
    return dec.decode(await this.readBinary(path));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const norm = normalizePath(path);
    const parent = dirname(norm);
    if (parent) this.addFolderRecursive(parent);
    const existing = this.resolveKey(norm);
    if (existing && existing !== norm) {
      this.files.delete(existing);
    }
    this.files.set(norm, { bytes: new Uint8Array(data), mtime: ++this.clock });
    this.onMutation?.('write', norm);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBinary(path, enc.encode(content));
  }

  async trashFile(path: string): Promise<void> {
    const key = this.resolveKey(path);
    if (!key) return;
    const item = this.files.get(key)!;
    this.trashed.set(key, item.bytes);
    this.files.delete(key);
    this.onMutation?.('delete', key);
  }

  async renamePath(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);
    const folderKey = this.resolveFolderKey(oldNorm);
    if (folderKey) {
      this.userRename(folderKey, newNorm, true);
      this.onMutation?.('rename', newNorm, folderKey, true);
      return;
    }
    const fileKey = this.resolveKey(oldNorm);
    if (fileKey) {
      this.userRename(fileKey, newNorm, false);
      this.onMutation?.('rename', newNorm, fileKey, false);
    }
  }

  async ensureFolder(folderPath: string): Promise<void> {
    this.addFolderRecursive(folderPath);
  }

  async removeEmptyFolder(folderPath: string): Promise<void> {
    const norm = normalizePath(folderPath);
    const prefix = norm + '/';
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) return;
    }
    this.folders.delete(norm);
  }

  isActiveEditorFile(): boolean {
    return false;
  }

  getLastActiveEditTime(): number {
    return 0;
  }

  async loadIndex(): Promise<SyncIndex> {
    return JSON.parse(JSON.stringify(this.index)) as SyncIndex;
  }

  async saveIndex(index: SyncIndex): Promise<void> {
    this.index = JSON.parse(JSON.stringify(index)) as SyncIndex;
  }

  async readBase(driveId: string): Promise<string | null> {
    return this.bases.has(driveId) ? this.bases.get(driveId)! : null;
  }

  async writeBase(driveId: string, content: string): Promise<void> {
    this.bases.set(driveId, content);
  }

  async deleteBase(driveId: string): Promise<void> {
    this.bases.delete(driveId);
  }

  async readPrevBase(driveId: string): Promise<string | null> {
    return this.prevBases.has(driveId) ? this.prevBases.get(driveId)! : null;
  }

  async writePrevBase(driveId: string, content: string): Promise<void> {
    this.prevBases.set(driveId, content);
  }

  async deletePrevBase(driveId: string): Promise<void> {
    this.prevBases.delete(driveId);
  }
}

// ============================================================================
// Helper: 3-Device Harness (Mac [APFS] + iPhone [APFS] + Android [Case-Sensitive])
// ============================================================================

interface DeviceNode {
  name: string;
  deviceId: string;
  vault: MockVaultAdapter;
  drive: MockDriveDeviceClient;
  signal: MockDeviceSignalBus;
  engine: SyncEngine;
  settings: TriSyncSettings;
}

async function createTriDeviceCluster(options: {
  signalMinIntervalMs?: number;
  wireEchoWatchers?: boolean;
} = {}) {
  const server = new MockGoogleDriveServer();
  const rootId = server.createRootFolder('PersonalVault');
  const hub = new MockFirestoreSignalHub();

  const makeDevice = async (
    deviceId: string,
    deviceName: string,
    caseInsensitive: boolean
  ): Promise<DeviceNode> => {
    const vault = new MockVaultAdapter({ caseInsensitive });
    const drive = server.createClientForDevice(deviceId);
    const signal = hub.createBus(deviceId, options.signalMinIntervalMs ?? 0);
    const settings: TriSyncSettings = {
      ...DEFAULT_SETTINGS,
      deviceId,
      deviceName,
      vaultId: 'vault-shared-1',
      vaultName: 'PersonalVault',
      vaultRootFolderId: rootId,
    };
    const engine = new SyncEngine({
      settings,
      vault,
      drive,
      signalBus: signal,
      activeEditorDeferMs: 0,
    });
    await engine.init();
    await engine.fullReconcile();

    if (options.wireEchoWatchers) {
      vault.onMutation = (kind, path, oldPath, isFolder) => {
        if (kind === 'write') {
          void engine.handleLocalCreateOrModify(path);
        } else if (kind === 'delete') {
          void engine.handleLocalDelete(path);
        } else if (kind === 'rename' && oldPath) {
          void engine.handleLocalRename(oldPath, path, Boolean(isFolder));
        }
      };
    }

    return { name: deviceName, deviceId, vault, drive, signal, engine, settings };
  };

  const mac = await makeDevice('dev-mac', 'MacBook', true);
  const iphone = await makeDevice('dev-iphone', 'iPhone', true);
  const android = await makeDevice('dev-android', 'Android', false);

  const settleAll = async () => {
    await mac.engine.runDeltaSync();
    await iphone.engine.runDeltaSync();
    await android.engine.runDeltaSync();
    // Second pass ensures any conflict copies / merges uploaded on pass 1 propagate everywhere
    await mac.engine.runDeltaSync();
    await iphone.engine.runDeltaSync();
    await android.engine.runDeltaSync();
  };

  return { server, hub, rootId, mac, iphone, android, settleAll };
}

// ============================================================================
// Full Chaos & Race Test Matrix (Section C.5)
// ============================================================================

describe('3-Device Chaos & Race Simulator (MacBook + iPhone + Android)', () => {
  it('1. propagates live 3-way edits with fast-path 1-GET pull and ZERO echo loops', async () => {
    const { server, mac, iphone, android } = await createTriDeviceCluster({
      wireEchoWatchers: true,
    });
    server.resetStats();

    mac.vault.userWriteText('Notes/Daily.md', '# Today\n- Ship TriSync\n');
    await mac.engine.handleLocalCreateOrModify('Notes/Daily.md');

    // Allow microtasks from wired echo watchers to drain
    await new Promise((r) => setTimeout(r, 20));

    expect(await iphone.vault.readText('Notes/Daily.md')).toBe('# Today\n- Ship TriSync\n');
    expect(await android.vault.readText('Notes/Daily.md')).toBe('# Today\n- Ship TriSync\n');

    // Exactly 1 create upload on Drive, 0 echo re-uploads!
    expect(server.stats.createFile).toBe(1);
    expect(server.stats.updateContent).toBe(0);
    // Fast-path pulled once per receiving device (2 total downloads)
    expect(server.stats.download).toBe(2);

    // Now iPhone edits -> propagates cleanly to Mac and Android with 0 echo loops
    server.resetStats();
    iphone.vault.userWriteText('Notes/Daily.md', '# Today\n- Ship TriSync\n- Test on iOS\n');
    await iphone.engine.handleLocalCreateOrModify('Notes/Daily.md');
    await new Promise((r) => setTimeout(r, 20));

    expect(await mac.vault.readText('Notes/Daily.md')).toBe(
      '# Today\n- Ship TriSync\n- Test on iOS\n'
    );
    expect(await android.vault.readText('Notes/Daily.md')).toBe(
      '# Today\n- Ship TriSync\n- Test on iOS\n'
    );
    expect(server.stats.updateContent).toBe(1);
    expect(server.stats.download).toBe(2);
  });

  it('2a. prevents silent data loss on offline-lagged §3.2 concurrent upload via pre-flight check', async () => {
    const { hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();

    mac.vault.userWriteText('Shared.md', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
    await mac.engine.handleLocalCreateOrModify('Shared.md');
    await settleAll();

    // Disable signals so Mac doesn't hear iPhone's upload before Mac starts its upload
    hub.dropPulses = true;

    iphone.vault.userWriteText('Shared.md', 'Line 1 (iPhone)\nLine 2\nLine 3\nLine 4\nLine 5\n');
    await iphone.engine.handleLocalCreateOrModify('Shared.md');

    // Mac edits bottom line and pushes blindly — Layer 1 pre-flight detects divergence and merges!
    mac.vault.userWriteText('Shared.md', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5 (Mac)\n');
    await mac.engine.handleLocalCreateOrModify('Shared.md');

    hub.dropPulses = false;
    await settleAll();

    const expected = 'Line 1 (iPhone)\nLine 2\nLine 3\nLine 4\nLine 5 (Mac)\n';
    expect(await mac.vault.readText('Shared.md')).toBe(expected);
    expect(await iphone.vault.readText('Shared.md')).toBe(expected);
    expect(await android.vault.readText('Shared.md')).toBe(expected);
  });

  it('2b. prevents silent data loss on 20ms TOCTOU sibling-overwrite race via parentMd5 + prevBase', async () => {
    const { hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();

    mac.vault.userWriteText('Race.md', 'Top\nMiddle A\nMiddle B\nBottom\n');
    await mac.engine.handleLocalCreateOrModify('Race.md');
    await settleAll();

    hub.dropPulses = true;

    // Simulate true TOCTOU window:
    // Mac passes Layer-1 pre-flight (seeing H1), then RIGHT BEFORE Mac's PATCH hits Drive,
    // iPhone lands R2 on Drive. Mac's PATCH then overwrites Drive with M2 (carrying parentMd5: H1)!
    let raceInjected = false;
    mac.drive.beforeUpdateContent = async () => {
      if (raceInjected) return;
      raceInjected = true;
      iphone.vault.userWriteText('Race.md', 'Top (iPhone)\nMiddle A\nMiddle B\nBottom\n');
      await iphone.engine.handleLocalCreateOrModify('Race.md');
    };

    mac.vault.userWriteText('Race.md', 'Top\nMiddle A\nMiddle B\nBottom (Mac)\n');
    await mac.engine.handleLocalCreateOrModify('Race.md');
    mac.drive.beforeUpdateContent = undefined;

    // Now iPhone pulls M2 from Drive: normally localMd5 === iPhone.md5 would wipe iPhone's edit,
    // BUT Layer 2 sees `M2.appProperties.parentMd5 === iPhone.prevMd5` and merges with `prevBase`!
    hub.dropPulses = false;
    await settleAll();

    const expected = 'Top (iPhone)\nMiddle A\nMiddle B\nBottom (Mac)\n';
    expect(await iphone.vault.readText('Race.md')).toBe(expected);
    expect(await mac.vault.readText('Race.md')).toBe(expected);
    expect(await android.vault.readText('Race.md')).toBe(expected);
  });

  it('3. resolves offline dual-create collisions for BOTH files (Notes/Same.md) and folders (Folder/Sub/) deterministically', async () => {
    const { server, hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();
    hub.dropPulses = true;
    // Simulate true simultaneous network race where both devices create Folder/Sub before either sees the other
    iphone.drive.simulateConcurrentBlindFolderCreate = true;
    android.drive.simulateConcurrentBlindFolderCreate = true;

    // Both iPhone and Android create Notes/Same.md and Folder/Sub/ independently without seeing each other
    iphone.vault.userWriteText('Notes/Same.md', 'Created on iPhone\n');
    iphone.vault.userWriteText('Folder/Sub/FromIphone.md', 'iPhone child\n');
    await iphone.engine.handleLocalCreateOrModify('Notes/Same.md');
    await iphone.engine.handleLocalCreateOrModify('Folder/Sub/FromIphone.md');

    android.vault.userWriteText('Notes/Same.md', 'Created on Android\n');
    android.vault.userWriteText('Folder/Sub/FromAndroid.md', 'Android child\n');
    await android.engine.handleLocalCreateOrModify('Notes/Same.md');
    await android.engine.handleLocalCreateOrModify('Folder/Sub/FromAndroid.md');

    iphone.drive.simulateConcurrentBlindFolderCreate = false;
    android.drive.simulateConcurrentBlindFolderCreate = false;

    // Verify Drive actually has duplicate folders and duplicate files right now
    const beforeItems = server.listLiveItems();
    expect(beforeItems.filter((i) => i.name === 'Same.md').length).toBe(2);
    expect(beforeItems.filter((i) => i.name === 'Sub').length).toBe(2);

    // Reconcile across all 3 devices -> deterministic canonical winner elected, losers trashed!
    hub.dropPulses = false;
    await settleAll();

    const afterItems = server.listLiveItems();
    expect(afterItems.filter((i) => i.name === 'Same.md').length).toBe(1);
    expect(afterItems.filter((i) => i.name === 'Sub').length).toBe(1);
    expect(afterItems.filter((i) => i.name === 'Folder').length).toBe(1);

    // Both nested children survive under the single canonical Folder/Sub/ on all 3 devices!
    for (const dev of [mac, iphone, android]) {
      expect(await dev.vault.readText('Folder/Sub/FromIphone.md')).toBe('iPhone child\n');
      expect(await dev.vault.readText('Folder/Sub/FromAndroid.md')).toBe('Android child\n');
      // Canonical Notes/Same.md + conflict copy preserve BOTH contents with zero data loss
      const allTexts = Object.values(dev.vault.getSnapshotTextMap());
      expect(allTexts).toContain('Created on iPhone\n');
      expect(allTexts).toContain('Created on Android\n');
    }

    // All 3 devices converge to the exact same canonical driveId for Notes/Same.md
    const idMac = mac.engine.getIndexSnapshot().files['Notes/Same.md'].driveId;
    const idIos = iphone.engine.getIndexSnapshot().files['Notes/Same.md'].driveId;
    const idAnd = android.engine.getIndexSnapshot().files['Notes/Same.md'].driveId;
    expect(idMac).toBe(idIos);
    expect(idIos).toBe(idAnd);
  });

  it('4. converges offline overlapping .md conflicts and binary PNG conflicts with zero conflict-of-conflict loops', async () => {
    const { server, hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();

    // Seed initial markdown + PNG
    const initialPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    mac.vault.userWriteText('Collision.md', 'Title\nSame line\nFooter\n');
    mac.vault.userWriteBinary('Assets/photo.png', initialPng);
    await mac.engine.handleLocalCreateOrModify('Collision.md');
    await mac.engine.handleLocalCreateOrModify('Assets/photo.png');
    await settleAll();

    // Offline overlapping edits on iPhone & Android
    hub.dropPulses = true;
    iphone.drive.offline = true;
    android.drive.offline = true;

    iphone.vault.userWriteText('Collision.md', 'Title\nEdited by iPhone\nFooter\n');
    const iphonePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 10, 20, 30, 40]);
    iphone.vault.userWriteBinary('Assets/photo.png', iphonePng);
    await iphone.engine.handleLocalCreateOrModify('Collision.md');
    await iphone.engine.handleLocalCreateOrModify('Assets/photo.png');

    android.vault.userWriteText('Collision.md', 'Title\nEdited by Android\nFooter\n');
    const androidPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 99, 88, 77, 66]);
    android.vault.userWriteBinary('Assets/photo.png', androidPng);
    await android.engine.handleLocalCreateOrModify('Collision.md');
    await android.engine.handleLocalCreateOrModify('Assets/photo.png');

    // Bring both back online
    iphone.drive.offline = false;
    android.drive.offline = false;
    hub.dropPulses = false;

    await iphone.engine.onResume();
    await android.engine.onResume();
    await settleAll();

    // Check all 3 devices converged identically with exactly 1 .md conflict copy and 1 .png conflict copy
    const macPaths = mac.vault.getAllPaths();
    const iosPaths = iphone.vault.getAllPaths();
    const andPaths = android.vault.getAllPaths();
    expect(macPaths).toEqual(iosPaths);
    expect(iosPaths).toEqual(andPaths);

    const mdConflicts = macPaths.filter((p) => p.includes('(conflict') && p.endsWith('.md'));
    const pngConflicts = macPaths.filter((p) => p.includes('(conflict') && p.endsWith('.png'));
    expect(mdConflicts.length).toBe(1);
    expect(pngConflicts.length).toBe(1);
    // Android-safe filename (no colons!)
    expect(mdConflicts[0]).not.toContain(':');
    expect(pngConflicts[0]).not.toContain(':');

    // Verify ZERO conflict-of-conflict loops after extra sync rounds
    server.resetStats();
    await settleAll();
    expect(server.stats.createFile).toBe(0);
    expect(server.stats.updateContent).toBe(0);
  });

  it('5. keeps canonical .canvas JSON.parse-valid when concurrent edits would produce broken JSON', async () => {
    const { hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();

    const crossBase = '[\n  0,\n  1,\n  2,\n  3,\n  4,\n  5,\n  6\n]\n';
    const crossLocal = '[\n  0,\n  {"x": [\n  1,\n  2,\n  3,\n  4]},\n  5,\n  6\n]\n';
    const crossRemote = '[\n  0,\n  1,\n  2,\n  [\n  3,\n  4,\n  5,\n  6]\n]\n';

    mac.vault.userWriteText('Board.canvas', crossBase);
    await mac.engine.handleLocalCreateOrModify('Board.canvas');
    await settleAll();

    hub.dropPulses = true;
    iphone.vault.userWriteText('Board.canvas', crossRemote);
    await iphone.engine.handleLocalCreateOrModify('Board.canvas');

    mac.vault.userWriteText('Board.canvas', crossLocal);
    await mac.engine.handleLocalCreateOrModify('Board.canvas');

    hub.dropPulses = false;
    await settleAll();

    for (const dev of [mac, iphone, android]) {
      const canonical = await dev.vault.readText('Board.canvas');
      // Canonical .canvas MUST remain valid JSON!
      expect(() => JSON.parse(canonical)).not.toThrow();
      const canvasConflicts = dev.vault
        .getAllPaths()
        .filter((p) => p.includes('(conflict') && p.endsWith('.canvas'));
      expect(canvasConflicts.length).toBe(1);
    }
  });

  it('6. renames a folder containing 100 nested files using 1 Drive PATCH and keeps bases/<driveId>.txt untouched', async () => {
    const { server, mac, iphone, android, settleAll } = await createTriDeviceCluster({
      wireEchoWatchers: true,
    });

    // Create 100 nested files inside Projects/Alpha/
    for (let i = 0; i < 100; i++) {
      mac.vault.userWriteText(`Projects/Alpha/note-${String(i).padStart(3, '0')}.md`, `Note ${i}\n`);
    }
    await mac.engine.fullReconcile();
    await settleAll();

    const baseIdsBeforeMac = mac.vault.getBaseIds();
    const baseIdsBeforeIos = iphone.vault.getBaseIds();
    expect(baseIdsBeforeMac.length).toBe(100);

    server.resetStats();

    // Local TFolder rename on Mac: Projects/Alpha -> Projects/Beta
    // (Also simulate Obsidian firing all 100 child TFile rename events right after!)
    mac.vault.userRename('Projects/Alpha', 'Projects/Beta', true);
    await mac.engine.handleLocalRename('Projects/Alpha', 'Projects/Beta', true);
    for (let i = 0; i < 100; i++) {
      const name = `note-${String(i).padStart(3, '0')}.md`;
      await mac.engine.handleLocalRename(
        `Projects/Alpha/${name}`,
        `Projects/Beta/${name}`,
        false
      );
    }

    await settleAll();

    // STRICTLY 1 Drive metadata PATCH for the folder rename and ZERO file content uploads!
    expect(server.stats.updateMetadata).toBe(1);
    expect(server.stats.updateContent).toBe(0);
    expect(server.stats.createFile).toBe(0);

    // bases/<driveId>.txt untouched across Mac & iPhone!
    expect(mac.vault.getBaseIds()).toEqual(baseIdsBeforeMac);
    expect(iphone.vault.getBaseIds()).toEqual(baseIdsBeforeIos);

    // All 3 devices have all 100 files under Projects/Beta/ and 0 under Projects/Alpha/
    for (const dev of [mac, iphone, android]) {
      const paths = dev.vault.getAllPaths();
      expect(paths.length).toBe(100);
      expect(paths.every((p) => p.startsWith('Projects/Beta/'))).toBe(true);
    }
  });

  it('7. enforces offline delete (stays deleted) AND edit-wins-over-delete (including 404 permanently removed re-create)', async () => {
    const { server, hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();

    mac.vault.userWriteText('DeleteMe.md', 'Original A\n');
    mac.vault.userWriteText('EditWinsTrash.md', 'Original B\n');
    mac.vault.userWriteText('EditWinsPurge.md', 'Original C\n');
    await mac.engine.fullReconcile();
    await settleAll();

    hub.dropPulses = true;

    // Case A: Offline local delete on iPhone while remote unchanged -> stays deleted everywhere!
    iphone.vault.userDelete('DeleteMe.md');
    await iphone.engine.fullReconcile();

    // Case B: Mac trashes EditWinsTrash.md while iPhone edits it offline -> edit wins!
    mac.vault.userDelete('EditWinsTrash.md');
    await mac.engine.handleLocalDelete('EditWinsTrash.md');
    iphone.vault.userWriteText('EditWinsTrash.md', 'Saved by iPhone edit!\n');

    // Case C: EditWinsPurge.md is PERMANENTLY removed (`removed: true` -> 404) on Drive
    // while Android edits it offline -> Android re-creates on 404!
    const purgeId = android.engine.getIndexSnapshot().files['EditWinsPurge.md'].driveId;
    server.permanentlyRemoveFile(purgeId);
    android.vault.userWriteText('EditWinsPurge.md', 'Resurrected by Android edit!\n');

    hub.dropPulses = false;
    await iphone.engine.runDeltaSync();
    await android.engine.runDeltaSync();
    await settleAll();

    for (const dev of [mac, iphone, android]) {
      expect(await dev.vault.exists('DeleteMe.md')).toBe(false);
      expect(await dev.vault.readText('EditWinsTrash.md')).toBe('Saved by iPhone edit!\n');
      expect(await dev.vault.readText('EditWinsPurge.md')).toBe('Resurrected by Android edit!\n');
    }
  });

  it('8. handles synced -> ignored (.trash/) as remote trash and ignored -> synced as remote upload', async () => {
    const { mac, iphone, android, settleAll } = await createTriDeviceCluster();

    mac.vault.userWriteText('Draft.md', 'Hello world\n');
    await mac.engine.handleLocalCreateOrModify('Draft.md');
    await settleAll();
    expect(await iphone.vault.exists('Draft.md')).toBe(true);

    // Move Draft.md into .trash/ (synced -> ignored) -> trashes remotely!
    mac.vault.userRename('Draft.md', '.trash/Draft.md', false);
    await mac.engine.handleLocalRename('Draft.md', '.trash/Draft.md', false);
    await settleAll();

    expect(await iphone.vault.exists('Draft.md')).toBe(false);
    expect(await android.vault.exists('Draft.md')).toBe(false);

    // Restore .trash/Draft.md -> Draft.md (ignored -> synced) -> uploads remotely!
    mac.vault.userRename('.trash/Draft.md', 'Draft.md', false);
    await mac.engine.handleLocalRename('.trash/Draft.md', 'Draft.md', false);
    await settleAll();

    expect(await iphone.vault.readText('Draft.md')).toBe('Hello world\n');
    expect(await android.vault.readText('Draft.md')).toBe('Hello world\n');
  });

  it('9. handles case-only rename (note.md -> Note.md) AND APFS remote case collision (readme.md + README.md)', async () => {
    const { mac, iphone, android, settleAll } = await createTriDeviceCluster();

    // Part A: Case-only rename on Mac (APFS) -> propagates cleanly to iPhone & Android
    mac.vault.userWriteText('note.md', 'Case test\n');
    await mac.engine.handleLocalCreateOrModify('note.md');
    await settleAll();

    mac.vault.userRename('note.md', 'Note.md', false);
    await mac.engine.handleLocalRename('note.md', 'Note.md', false);
    await settleAll();

    expect(mac.vault.getAllPaths()).toContain('Note.md');
    expect(iphone.vault.getAllPaths()).toContain('Note.md');
    expect(android.vault.getAllPaths()).toContain('Note.md');
    expect(android.vault.getAllPaths()).not.toContain('note.md');

    // Part B: Case-sensitive Android creates BOTH readme.md and README.md
    android.vault.userWriteText('readme.md', 'lowercase content\n');
    await android.engine.handleLocalCreateOrModify('readme.md');
    android.vault.userWriteText('README.md', 'UPPERCASE content\n');
    await android.engine.handleLocalCreateOrModify('README.md');
    await settleAll();

    // On case-insensitive APFS MacBook, BOTH contents must exist without clobbering!
    const macSnap = mac.vault.getSnapshotTextMap();
    const macValues = Object.values(macSnap);
    expect(macValues).toContain('lowercase content\n');
    expect(macValues).toContain('UPPERCASE content\n');
    expect(
      Object.keys(macSnap).some((p) => p.includes('(case-conflict'))
    ).toBe(true);
  });

  it('10. isolates multiple vaults sharing a single Google Drive changes.list stream', async () => {
    const { server, mac, iphone, settleAll } = await createTriDeviceCluster();

    // Create VaultB on the SAME Google Drive server (same changes.list feed!)
    const vaultBRoot = server.createRootFolder('VaultB');
    const vaultBClient = server.createClientForDevice('dev-vault-b');
    await vaultBClient.createFile({
      name: 'SecretVaultB.md',
      parentId: vaultBRoot,
      mimeType: 'text/markdown',
      content: enc.encode('Vault B private note'),
    });

    // VaultA file
    mac.vault.userWriteText('VaultANote.md', 'Vault A note\n');
    await mac.engine.handleLocalCreateOrModify('VaultANote.md');
    await settleAll();

    expect(await mac.vault.exists('VaultANote.md')).toBe(true);
    expect(await iphone.vault.exists('VaultANote.md')).toBe(true);
    // VaultB's file must NEVER leak into VaultA!
    expect(await mac.vault.exists('SecretVaultB.md')).toBe(false);
    expect(await iphone.vault.exists('SecretVaultB.md')).toBe(false);
  });

  it('11. converges 100% during total Firestore outage & throttles 3,000-file bulk signal to 1 write', async () => {
    const { hub, mac, iphone, android, settleAll } = await createTriDeviceCluster({
      signalMinIntervalMs: 1000,
    });

    // Total Firestore outage -> pure Drive changes.list fallback works 100%
    hub.offline = true;
    mac.vault.userWriteText('OfflineBus.md', 'Synced without Firestore!\n');
    await mac.engine.handleLocalCreateOrModify('OfflineBus.md');
    await settleAll();

    expect(await iphone.vault.readText('OfflineBus.md')).toBe('Synced without Firestore!\n');
    expect(await android.vault.readText('OfflineBus.md')).toBe('Synced without Firestore!\n');

    // Batch/Throttle check: 3,000 changes pushed into SignalBatcher produce strictly 1 Firestore write
    // with `requiresDeltaSync: true` and ring buffer capped at 10 entries!
    hub.offline = false;
    let capturedDocs: SignalDocument[] = [];
    let fakeNow = 10_000;
    const batcher = new SignalBatcher(
      'dev-mac',
      async (doc) => {
        capturedDocs.push(doc);
      },
      { minIntervalMs: 1000, now: () => fakeNow }
    );

    const bulkItems: OutgoingSignalItem[] = Array.from({ length: 3000 }, (_, i) => ({
      id: `file_${i}`,
      path: `Bulk/note_${i}.md`,
      md5: `md5_${i}`,
    }));
    await batcher.enqueue(bulkItems, { immediate: true });
    await batcher.flush();

    expect(capturedDocs.length).toBe(1);
    expect(capturedDocs[0].requiresDeltaSync).toBe(true);
    expect(capturedDocs[0].entries.length).toBe(10);
    batcher.dispose();
  });

  it('12. recovers cleanly from crash/restart mid-offline-rename via persisted dirtyRenames', async () => {
    const { server, hub, rootId, mac, iphone, android, settleAll } =
      await createTriDeviceCluster();

    mac.vault.userWriteText('OldName.md', 'Important note\n');
    await mac.engine.handleLocalCreateOrModify('OldName.md');
    await settleAll();

    // Mac goes offline and renames OldName.md -> NewName.md, persisting dirtyRenames in sync-index.json
    mac.drive.offline = true;
    mac.vault.userRename('OldName.md', 'NewName.md', false);
    await mac.engine.handleLocalRename('OldName.md', 'NewName.md', false);

    // Verify dirtyRename persisted on disk!
    const persistedBeforeCrash = await mac.vault.loadIndex();
    expect(persistedBeforeCrash.dirtyRenames.length).toBe(1);
    expect(persistedBeforeCrash.dirtyRenames[0].newPath).toBe('NewName.md');

    // Simulate process CRASH and fresh SyncEngine restart on MacBook (back online)
    mac.engine.dispose();
    const freshDrive = server.createClientForDevice('dev-mac');
    const freshSignal = hub.createBus('dev-mac', 0);
    const restartedMacEngine = new SyncEngine({
      settings: { ...mac.settings, vaultRootFolderId: rootId },
      vault: mac.vault,
      drive: freshDrive,
      signalBus: freshSignal,
      activeEditorDeferMs: 0,
    });
    await restartedMacEngine.init();
    await restartedMacEngine.onResume();

    // Dirty rename should now be cleared and propagated to Drive, iPhone, and Android!
    expect((await mac.vault.loadIndex()).dirtyRenames.length).toBe(0);
    await iphone.engine.runDeltaSync();
    await android.engine.runDeltaSync();

    expect(await iphone.vault.exists('OldName.md')).toBe(false);
    expect(await iphone.vault.readText('NewName.md')).toBe('Important note\n');
    expect(await android.vault.exists('OldName.md')).toBe(false);
    expect(await android.vault.readText('NewName.md')).toBe('Important note\n');
    restartedMacEngine.dispose();
  });

  // ============================================================================
  // Phase 2 Regression Tests (Audit #8 items 1-10)
  // ============================================================================

  it('13. [Reg #1] SignalBatcher preserves HLC monotonicity on cold boot and handles concurrent colliding seq via pulseId', async () => {
    // Part A: Cold-boot monotonicity — seeded with initialSeq=50000, NEVER resets to seq=1
    const emitted: SignalDocument[] = [];
    const coldBatcher = new SignalBatcher(
      'dev-restarted',
      async (doc) => {
        emitted.push(doc);
      },
      { initialSeq: 50_000, now: () => 1_000, minIntervalMs: 0 }
    );
    await coldBatcher.enqueue([{ id: 'f1', path: 'A.md', md5: 'aaa' }], { immediate: true });
    expect(emitted.length).toBe(1);
    expect(emitted[0].seq).toBeGreaterThan(50_000);
    expect(emitted[0].pulseId).toBeTruthy();
    coldBatcher.dispose();

    // Part B: Concurrent seq collision — iPhone and Mac both publish at the EXACT same seq
    // with distinct pulseIds -> neither drops the other's signal!
    const { mac, iphone } = await createTriDeviceCluster();
    const sharedSeq = Date.now() + 99_999;

    // Upload files to Drive directly via Mac & iPhone with signals suppressed first
    mac.signal.setConnected(false);
    iphone.signal.setConnected(false);

    mac.vault.userWriteText('FromMac.md', 'Mac content\n');
    await mac.engine.handleLocalCreateOrModify('FromMac.md');
    const macId = mac.engine.getIndexSnapshot().files['FromMac.md'].driveId;

    iphone.vault.userWriteText('FromIphone.md', 'iPhone content\n');
    await iphone.engine.handleLocalCreateOrModify('FromIphone.md');
    const iosId = iphone.engine.getIndexSnapshot().files['FromIphone.md'].driveId;

    // Seed both devices to already have lastSeenSignalSeq === sharedSeq (simulating same-seq concurrent publish)
    await mac.engine.handleIncomingSignal({
      seq: sharedSeq,
      pulseId: 'pulse-from-iphone-1',
      sender: 'dev-iphone',
      updatedAt: Date.now(),
      entries: [
        {
          seq: sharedSeq,
          id: iosId,
          path: 'FromIphone.md',
          md5: md5Bytes(enc.encode('iPhone content\n')),
        },
      ],
    });

    // Now a second concurrent pulse arrives at the SAME or LOWER seq (`sharedSeq`) with a NEW pulseId!
    iphone.vault.userWriteText('FromIphone2.md', 'Second concurrent note\n');
    await iphone.engine.handleLocalCreateOrModify('FromIphone2.md');
    const iosId2 = iphone.engine.getIndexSnapshot().files['FromIphone2.md'].driveId;

    await mac.engine.handleIncomingSignal({
      seq: sharedSeq, // exact colliding seq!
      pulseId: 'pulse-from-iphone-2',
      sender: 'dev-iphone',
      updatedAt: Date.now(),
      entries: [
        {
          seq: sharedSeq,
          id: iosId2,
          path: 'FromIphone2.md',
          md5: md5Bytes(enc.encode('Second concurrent note\n')),
        },
      ],
    });

    expect(await mac.vault.readText('FromIphone.md')).toBe('iPhone content\n');
    expect(await mac.vault.readText('FromIphone2.md')).toBe('Second concurrent note\n');
    expect(macId).toBeTruthy();
  });

  it('14. [Reg #2] does NOT commit lastSeenSignalSeq/lastSeenPulseId when pull/delta fails offline', async () => {
    const { hub, mac, iphone } = await createTriDeviceCluster();
    hub.dropPulses = true;

    mac.vault.userWriteText('Transient.md', 'Must not be dropped!\n');
    await mac.engine.handleLocalCreateOrModify('Transient.md');
    const fileId = mac.engine.getIndexSnapshot().files['Transient.md'].driveId;
    const expectedMd5 = md5Bytes(enc.encode('Must not be dropped!\n'));

    const beforeSeq = iphone.engine.getIndexSnapshot().lastSeenSignalSeq;
    const incomingPulse: SignalDocument = {
      seq: beforeSeq + 1000,
      pulseId: 'pulse-transient-fail',
      sender: 'dev-mac',
      updatedAt: Date.now(),
      entries: [{ seq: beforeSeq + 1000, id: fileId, path: 'Transient.md', md5: expectedMd5 }],
    };

    // iPhone is transiently offline when signal arrives -> pull & delta fail
    iphone.drive.offline = true;
    await expect(iphone.engine.handleIncomingSignal(incomingPulse)).rejects.toThrow(/offline/i);

    // Cursor MUST NOT have advanced!
    expect(iphone.engine.getIndexSnapshot().lastSeenSignalSeq).toBe(beforeSeq);
    expect(iphone.engine.getIndexSnapshot().lastSeenPulseId).not.toBe('pulse-transient-fail');
    expect(await iphone.vault.exists('Transient.md')).toBe(false);

    // Reconnect and redeliver the exact same pulse -> now succeeds and commits cursor!
    iphone.drive.offline = false;
    await iphone.engine.handleIncomingSignal(incomingPulse);

    expect(await iphone.vault.readText('Transient.md')).toBe('Must not be dropped!\n');
    expect(iphone.engine.getIndexSnapshot().lastSeenPulseId).toBe('pulse-transient-fail');
    expect(iphone.engine.getIndexSnapshot().lastSeenSignalSeq).toBe(beforeSeq + 1000);
  });

  it('15. [Reg #3] switching vaultRootFolderId resets stale index and NEVER trashes local vault', async () => {
    const { server, mac } = await createTriDeviceCluster();

    mac.vault.userWriteText('KeepMe.md', 'Precious local note\n');
    await mac.engine.handleLocalCreateOrModify('KeepMe.md');
    expect(mac.engine.getIndexSnapshot().files['KeepMe.md']).toBeDefined();

    // Switch to a brand-new empty Drive vault root (e.g. re-onboarding via Setup Bundle)
    const newRootId = server.createRootFolder('BrandNewVault');
    await mac.engine.resetForNewVaultRoot(newRootId);
    await mac.engine.fullReconcile();

    // Local file MUST still exist (NOT moved to .trash/) and MUST be uploaded into the new root!
    expect(await mac.vault.readText('KeepMe.md')).toBe('Precious local note\n');
    expect(mac.vault.getTrashedPaths()).toEqual([]);
    const newIndex = mac.engine.getIndexSnapshot();
    expect(newIndex.vaultRootFolderId).toBe(newRootId);
    expect(newIndex.files['KeepMe.md']).toBeDefined();
    const remoteMeta = server.getRawItem(newIndex.files['KeepMe.md'].driveId)?.meta;
    expect(remoteMeta?.parents).toEqual([newRootId]);
  });

  it('16. [Reg #4] APFS case-different modify replaces old index key without duplicates + ObsidianVaultAdapter 2-step temp rename hop', async () => {
    const { server, mac } = await createTriDeviceCluster();

    mac.vault.userWriteText('Notes/todo.md', 'v1\n');
    await mac.engine.handleLocalCreateOrModify('Notes/todo.md');
    const origId = mac.engine.getIndexSnapshot().files['Notes/todo.md'].driveId;

    // On APFS (caseInsensitive: true), modify arrives under different casing `Notes/Todo.md`
    mac.vault.userWriteText('Notes/Todo.md', 'v2\n');
    await mac.engine.handleLocalCreateOrModify('Notes/Todo.md');

    const idxFiles = mac.engine.getIndexSnapshot().files;
    expect(Object.keys(idxFiles)).toEqual(['Notes/Todo.md']);
    expect(idxFiles['Notes/todo.md']).toBeUndefined();
    expect(idxFiles['Notes/Todo.md'].driveId).toBe(origId);
    // Remote Drive filename also updated to `Todo.md`!
    expect(server.getRawItem(origId)?.meta.name).toBe('Todo.md');

    // Also verify ObsidianVaultAdapter 2-step temp rename hop when direct APFS case-rename throws
    const renameCalls: Array<[string, string]> = [];
    const hops: Array<[string, string, string]> = [];
    const fakeFile = { path: 'todo.md', extension: 'md' };
    const fakeApp = {
      vault: {
        configDir: '.obsidian',
        getAbstractFileByPath: (p: string) => (p === fakeFile.path ? fakeFile : null),
        getAllLoadedFiles: () => [fakeFile],
        rename: async (f: { path: string }, next: string) => {
          renameCalls.push([f.path, next]);
          if (f.path === 'todo.md' && next === 'Todo.md') {
            throw new Error('EEXIST: file already exists on APFS');
          }
          f.path = next;
        },
      },
      workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
    };

    const adapter = new ObsidianVaultAdapter(fakeApp as never, {
      caseInsensitive: true,
      onTempRenameHop: (o, t, n) => hops.push([o, t, n]),
    });

    await adapter.renamePath('todo.md', 'Todo.md');
    expect(fakeFile.path).toBe('Todo.md');
    expect(hops.length).toBe(1);
    expect(hops[0][0]).toBe('todo.md');
    expect(hops[0][1]).toContain('.trisync-case-');
    expect(hops[0][2]).toBe('Todo.md');
    expect(renameCalls.length).toBe(3); // direct attempt (throws) + hop to temp + hop to Todo.md
  });

  it('17. [Reg #5] concurrent 3-device wake on 2-way dual-create converges to strictly 1 conflict copy', async () => {
    const { server, hub, mac, iphone, android, settleAll } = await createTriDeviceCluster();
    hub.dropPulses = true;
    iphone.drive.simulateConcurrentBlindFolderCreate = true;
    android.drive.simulateConcurrentBlindFolderCreate = true;

    iphone.vault.userWriteText('Dual.md', 'iPhone offline version\n');
    await iphone.engine.handleLocalCreateOrModify('Dual.md');

    android.vault.userWriteText('Dual.md', 'Android offline version\n');
    await android.engine.handleLocalCreateOrModify('Dual.md');

    iphone.drive.simulateConcurrentBlindFolderCreate = false;
    android.drive.simulateConcurrentBlindFolderCreate = false;
    hub.dropPulses = false;

    // All 3 devices wake up simultaneously!
    await Promise.all([
      mac.engine.runDeltaSync(),
      iphone.engine.runDeltaSync(),
      android.engine.runDeltaSync(),
    ]);
    await settleAll();

    for (const dev of [mac, iphone, android]) {
      const snap = dev.vault.getSnapshotTextMap();
      const conflicts = dev.vault.getAllPaths().filter((p) => p.includes('(conflict'));
      expect(conflicts.length).toBe(1); // Strictly 1 deterministic conflict copy, NOT 3!
      const vals = Object.values(snap);
      expect(vals).toContain('iPhone offline version\n');
      expect(vals).toContain('Android offline version\n');
    }
  });

  it('18. [Reg #6] offline folder rename does NOT double-remap newly created files and coalesces chained dirtyRenames', async () => {
    const { mac, iphone, settleAll } = await createTriDeviceCluster();

    mac.vault.userWriteText('Projects/Old.md', 'Old file\n');
    mac.vault.userWriteText('ChainA.md', 'Chained file\n');
    await mac.engine.fullReconcile();
    await settleAll();

    // Go offline on Mac
    mac.drive.offline = true;

    // Rename Projects -> Archive offline, THEN create brand-new Projects/Fresh.md offline!
    mac.vault.userRename('Projects', 'Archive', true);
    await mac.engine.handleLocalRename('Projects', 'Archive', true);

    mac.vault.userWriteText('Projects/Fresh.md', 'Brand new in Projects\n');
    await mac.engine.handleLocalCreateOrModify('Projects/Fresh.md');

    // Chained offline file rename: ChainA.md -> ChainB.md -> ChainC.md
    mac.vault.userRename('ChainA.md', 'ChainB.md', false);
    await mac.engine.handleLocalRename('ChainA.md', 'ChainB.md', false);
    mac.vault.userRename('ChainB.md', 'ChainC.md', false);
    await mac.engine.handleLocalRename('ChainB.md', 'ChainC.md', false);

    // Chained dirtyRenames MUST be coalesced to 1 entry for ChainA -> ChainC!
    const dirtyBefore = mac.engine.getIndexSnapshot().dirtyRenames;
    const fileDirty = dirtyBefore.filter((d) => !d.isFolder);
    expect(fileDirty.length).toBe(1);
    expect(fileDirty[0].oldPath).toBe('ChainA.md');
    expect(fileDirty[0].newPath).toBe('ChainC.md');

    // Come back online and flush + sync!
    mac.drive.offline = false;
    await mac.engine.onResume();
    await settleAll();

    // `Projects/Fresh.md` MUST stay in `Projects/Fresh.md` (NOT clobbered into `Archive/Fresh.md`!)
    expect(await mac.vault.readText('Archive/Old.md')).toBe('Old file\n');
    expect(await mac.vault.readText('Projects/Fresh.md')).toBe('Brand new in Projects\n');
    expect(await mac.vault.exists('Archive/Fresh.md')).toBe(false);
    expect(await mac.vault.readText('ChainC.md')).toBe('Chained file\n');

    expect(await iphone.vault.readText('Archive/Old.md')).toBe('Old file\n');
    expect(await iphone.vault.readText('Projects/Fresh.md')).toBe('Brand new in Projects\n');
    expect(await iphone.vault.readText('ChainC.md')).toBe('Chained file\n');
    expect(await iphone.vault.exists('ChainA.md')).toBe(false);
    expect(await iphone.vault.exists('ChainB.md')).toBe(false);
  });

  it('19. [Reg #7] syncs empty folders (create/delete) and reuses existing Drive folders without duplication', async () => {
    const { server, mac, iphone, android, settleAll } = await createTriDeviceCluster();

    // Empty folder create on Mac propagates to iPhone & Android
    await mac.vault.ensureFolder('EmptyBox/NestedEmpty');
    await mac.engine.handleLocalFolderCreate('EmptyBox/NestedEmpty');
    await settleAll();

    expect(await iphone.vault.exists('EmptyBox/NestedEmpty')).toBe(true);
    expect(await android.vault.exists('EmptyBox/NestedEmpty')).toBe(true);

    // Empty folder delete on Mac removes it on iPhone & Android
    await mac.vault.removeEmptyFolder('EmptyBox/NestedEmpty');
    await mac.engine.handleLocalFolderDelete('EmptyBox/NestedEmpty');
    await settleAll();
    expect(await iphone.vault.exists('EmptyBox/NestedEmpty')).toBe(false);
    expect(await android.vault.exists('EmptyBox/NestedEmpty')).toBe(false);

    // Another device with stale folderMap reuses the existing remote folder instead of creating a duplicate!
    server.resetStats();
    const existingId = mac.engine.getIndexSnapshot().folderMap['EmptyBox'];
    const androidRoot = android.engine.getIndexSnapshot().vaultRootFolderId!;
    await android.engine.resetForNewVaultRoot(androidRoot);
    android.vault.userWriteText('EmptyBox/Ping.md', 'hi\n');
    await android.engine.handleLocalCreateOrModify('EmptyBox/Ping.md');

    expect(server.stats.createFolder).toBe(0); // Reused existing EmptyBox!
    expect(android.engine.getIndexSnapshot().folderMap['EmptyBox']).toBe(existingId);
  });

  it('20. [Reg #9] ObsidianVaultAdapter serializes concurrent saveIndex() writes strictly one at a time', async () => {
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    let lastWritten = '';
    const existingDirs = new Set<string>();

    const fakeApp = {
      vault: {
        configDir: '.obsidian',
        adapter: {
          exists: async (p: string) => existingDirs.has(p),
          mkdir: async (p: string) => {
            existingDirs.add(p);
          },
          write: async (_p: string, content: string) => {
            activeWrites++;
            if (activeWrites > maxConcurrentWrites) {
              maxConcurrentWrites = activeWrites;
            }
            await new Promise((r) => setTimeout(r, 5));
            lastWritten = content;
            activeWrites--;
          },
        },
      },
      workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
    };

    const adapter = new ObsidianVaultAdapter(fakeApp as never);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const idx = createEmptySyncIndex(`root-${i}`);
        idx.lastSeenSignalSeq = i;
        return adapter.saveIndex(idx);
      })
    );

    expect(maxConcurrentWrites).toBe(1);
    const parsed = JSON.parse(lastWritten) as SyncIndex;
    expect(parsed.lastSeenSignalSeq).toBe(11);
  });
});
