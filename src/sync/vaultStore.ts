import type { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { createEmptySyncIndex, type SyncIndex } from '../types';
import { dirname, foldPath, normalizePath } from './ignore';

/**
 * Vault storage abstraction + Obsidian implementation.
 *
 * Safeguards:
 * - Zero runtime `obsidian` imports (uses `import type` + structural checks) so Vitest runs natively.
 * - Uses `app.vault.process` for existing text files to preserve CM6 cursor & scroll position.
 * - Flushes dirty open `MarkdownView` (`await view.save()`) before reading local Markdown content.
 * - Always calls `app.vault.trash(file, false)` (`.trash/` — mobile safe on iOS/Android).
 * - NFC/NFD fallback lookup around `vault.getAbstractFileByPath` (handles macOS Finder NFD filenames).
 * - Persists `sync-index.json` and `bases/<driveId>.txt` (+ `<driveId>.prev.txt`) in
 *   `.obsidian/plugins/obsidian-trisync/` via `vault.adapter` (immune to iOS IndexedDB eviction).
 */

export interface VaultFileInfo {
  path: string; // NFC normalized
  rawPath: string;
  mtime: number;
  size: number;
}

export interface IVaultAdapter {
  readonly caseInsensitive: boolean;
  listFiles(): Promise<VaultFileInfo[]>;
  listFolders(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  findExistingPath(path: string): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  trashFile(path: string): Promise<void>;
  renamePath(oldPath: string, newPath: string): Promise<void>;
  ensureFolder(folderPath: string): Promise<void>;
  removeEmptyFolder(folderPath: string): Promise<void>;
  isActiveEditorFile(path: string): boolean;
  getLastActiveEditTime(path: string): number;

  // Private plugin state storage (.obsidian/plugins/obsidian-trisync/)
  loadIndex(): Promise<SyncIndex>;
  saveIndex(index: SyncIndex): Promise<void>;
  readBase(driveId: string): Promise<string | null>;
  writeBase(driveId: string, content: string): Promise<void>;
  deleteBase(driveId: string): Promise<void>;
  readPrevBase(driveId: string): Promise<string | null>;
  writePrevBase(driveId: string, content: string): Promise<void>;
  deletePrevBase(driveId: string): Promise<void>;
}

function isTFile(file: TAbstractFile | null | undefined): file is TFile {
  return Boolean(file && typeof (file as TFile).extension === 'string');
}

function isTFolder(file: TAbstractFile | null | undefined): file is TFolder {
  return Boolean(file && Array.isArray((file as TFolder).children));
}

function sanitizeBaseId(driveId: string): string {
  return driveId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface MarkdownViewLike {
  getViewType?: () => string;
  file?: TFile | null;
  save?: () => Promise<void>;
}

export class ObsidianVaultAdapter implements IVaultAdapter {
  readonly caseInsensitive: boolean;
  private readonly pluginDir: string;
  private readonly indexPath: string;
  private readonly basesDir: string;
  private readonly lastActiveEditByPath = new Map<string, number>();
  private saveIndexTail: Promise<void> = Promise.resolve();
  private onTempRenameHop?: (oldPath: string, tempPath: string, newPath: string) => void;

  constructor(
    private readonly app: App,
    options: {
      pluginId?: string;
      caseInsensitive?: boolean;
      onTempRenameHop?: (oldPath: string, tempPath: string, newPath: string) => void;
    } = {}
  ) {
    const pluginId = options.pluginId ?? 'obsidian-trisync';
    const configDir = normalizePath(this.app.vault.configDir || '.obsidian');
    this.pluginDir = `${configDir}/plugins/${pluginId}`;
    this.indexPath = `${this.pluginDir}/sync-index.json`;
    this.basesDir = `${this.pluginDir}/bases`;
    this.caseInsensitive = options.caseInsensitive ?? true;
    this.onTempRenameHop = options.onTempRenameHop;
  }

  setTempRenameHopCallback(
    cb: (oldPath: string, tempPath: string, newPath: string) => void
  ): void {
    this.onTempRenameHop = cb;
  }

  recordActiveEditorEdit(rawPath: string, timestamp: number = Date.now()): void {
    const key = this.caseInsensitive ? foldPath(rawPath) : normalizePath(rawPath);
    this.lastActiveEditByPath.set(key, timestamp);
  }

  isActiveEditorFile(rawPath: string): boolean {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return false;
    return this.caseInsensitive
      ? foldPath(activeFile.path) === foldPath(rawPath)
      : normalizePath(activeFile.path) === normalizePath(rawPath);
  }

  getLastActiveEditTime(rawPath: string): number {
    const key = this.caseInsensitive ? foldPath(rawPath) : normalizePath(rawPath);
    return this.lastActiveEditByPath.get(key) ?? 0;
  }

  /**
   * NFC / NFD / case-folded fallback lookup around `vault.getAbstractFileByPath`.
   */
  private resolveAbstractFile(rawPath: string): TAbstractFile | null {
    const nfc = normalizePath(rawPath);
    if (!nfc) return null;

    const exact = this.app.vault.getAbstractFileByPath(nfc);
    if (exact) return exact;

    const nfd = nfc.normalize('NFD');
    if (nfd !== nfc) {
      const nfdMatch = this.app.vault.getAbstractFileByPath(nfd);
      if (nfdMatch) return nfdMatch;
    }

    const foldedTarget = foldPath(nfc);
    const all = this.app.vault.getAllLoadedFiles();
    for (const candidate of all) {
      const candNfc = normalizePath(candidate.path);
      if (candNfc === nfc) return candidate;
      if (this.caseInsensitive && foldPath(candNfc) === foldedTarget) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Flushes any open dirty MarkdownView for `rawPath` before reading so unsaved
   * CM6 keystrokes sitting in Obsidian's debounce buffer are never missed.
   */
  private async flushOpenEditorForPath(rawPath: string): Promise<void> {
    const targetKey = this.caseInsensitive ? foldPath(rawPath) : normalizePath(rawPath);
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view as unknown as MarkdownViewLike;
      if (view && view.file && typeof view.save === 'function') {
        const viewKey = this.caseInsensitive
          ? foldPath(view.file.path)
          : normalizePath(view.file.path);
        if (viewKey === targetKey) {
          try {
            await view.save();
          } catch {
            // Best-effort flush; continue reading
          }
        }
      }
    }
  }

  async listFiles(): Promise<VaultFileInfo[]> {
    const files = this.app.vault.getFiles();
    return files.map((f) => ({
      path: normalizePath(f.path),
      rawPath: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  async listFolders(): Promise<string[]> {
    const folders: string[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (isTFolder(f) && f.path && f.path !== '/') {
        folders.push(normalizePath(f.path));
      }
    }
    return folders;
  }

  async exists(rawPath: string): Promise<boolean> {
    if (this.resolveAbstractFile(rawPath)) return true;
    return this.app.vault.adapter.exists(normalizePath(rawPath));
  }

  async findExistingPath(rawPath: string): Promise<string | null> {
    const found = this.resolveAbstractFile(rawPath);
    return found ? normalizePath(found.path) : null;
  }

  async readBinary(rawPath: string): Promise<Uint8Array> {
    await this.flushOpenEditorForPath(rawPath);
    const abs = this.resolveAbstractFile(rawPath);
    if (isTFile(abs)) {
      const buf = await this.app.vault.readBinary(abs);
      return new Uint8Array(buf);
    }
    const buf = await this.app.vault.adapter.readBinary(normalizePath(rawPath));
    return new Uint8Array(buf);
  }

  async readText(rawPath: string): Promise<string> {
    await this.flushOpenEditorForPath(rawPath);
    const abs = this.resolveAbstractFile(rawPath);
    if (isTFile(abs)) {
      return this.app.vault.read(abs);
    }
    return this.app.vault.adapter.read(normalizePath(rawPath));
  }

  async ensureFolder(folderPath: string): Promise<void> {
    const norm = normalizePath(folderPath);
    if (!norm) return;
    const parts = norm.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.resolveAbstractFile(current);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Folder may already exist on disk
        }
      }
    }
  }

  async writeBinary(rawPath: string, data: Uint8Array): Promise<void> {
    const norm = normalizePath(rawPath);
    const parent = dirname(norm);
    if (parent) {
      await this.ensureFolder(parent);
    }
    const exactBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const abs = this.resolveAbstractFile(norm);
    if (isTFile(abs)) {
      await this.app.vault.modifyBinary(abs, exactBuf);
    } else {
      await this.app.vault.createBinary(norm, exactBuf);
    }
  }

  async writeText(rawPath: string, content: string): Promise<void> {
    const norm = normalizePath(rawPath);
    const parent = dirname(norm);
    if (parent) {
      await this.ensureFolder(parent);
    }
    const abs = this.resolveAbstractFile(norm);
    if (isTFile(abs)) {
      // Use `vault.process` to preserve open CM6 editor cursor & scroll position!
      await this.app.vault.process(abs, () => content);
    } else {
      await this.app.vault.create(norm, content);
    }
  }

  async trashFile(rawPath: string): Promise<void> {
    const abs = this.resolveAbstractFile(rawPath);
    if (abs) {
      // Strictly use Obsidian `.trash/` (`system = false`) for iOS/Android compatibility!
      await this.app.vault.trash(abs, false);
    }
  }

  async renamePath(rawOldPath: string, rawNewPath: string): Promise<void> {
    const oldNorm = normalizePath(rawOldPath);
    const newNorm = normalizePath(rawNewPath);
    if (oldNorm === newNorm) return;

    const abs = this.resolveAbstractFile(oldNorm);
    if (!abs) return;

    const newParent = dirname(newNorm);
    if (newParent) {
      await this.ensureFolder(newParent);
    }

    try {
      await this.app.vault.rename(abs, newNorm);
    } catch (err) {
      // On case-insensitive APFS/Windows, direct case-only renames (`todo.md` -> `Todo.md`)
      // can throw EEXIST. Fall back to a 2-step echo-suppressed temporary rename hop.
      if (foldPath(oldNorm) === foldPath(newNorm)) {
        const shortId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const tempPath = `${newNorm}.trisync-case-${shortId}`;
        this.onTempRenameHop?.(oldNorm, tempPath, newNorm);
        await this.app.vault.rename(abs, tempPath);
        const tempAbs = this.resolveAbstractFile(tempPath) ?? abs;
        await this.app.vault.rename(tempAbs, newNorm);
        return;
      }
      throw err;
    }
  }

  async removeEmptyFolder(folderPath: string): Promise<void> {
    const abs = this.resolveAbstractFile(folderPath);
    if (isTFolder(abs) && abs.children.length === 0) {
      try {
        await this.app.vault.trash(abs, false);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private async ensurePrivateDirs(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.pluginDir))) {
      await adapter.mkdir(this.pluginDir);
    }
    if (!(await adapter.exists(this.basesDir))) {
      await adapter.mkdir(this.basesDir);
    }
  }

  async loadIndex(): Promise<SyncIndex> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(this.indexPath)) {
        const raw = await adapter.read(this.indexPath);
        const parsed = JSON.parse(raw) as Partial<SyncIndex>;
        return {
          ...createEmptySyncIndex(parsed.vaultRootFolderId ?? null),
          ...parsed,
          folderMap: parsed.folderMap ?? {},
          files: parsed.files ?? {},
          pendingOps: Array.isArray(parsed.pendingOps) ? parsed.pendingOps : [],
          dirtyRenames: Array.isArray(parsed.dirtyRenames) ? parsed.dirtyRenames : [],
          lastSeenSignalSeq:
            typeof parsed.lastSeenSignalSeq === 'number' ? parsed.lastSeenSignalSeq : 0,
          lastSeenPulseId:
            typeof parsed.lastSeenPulseId === 'string' ? parsed.lastSeenPulseId : undefined,
        };
      }
    } catch {
      // Corrupted index -> start fresh index safely
    }
    return createEmptySyncIndex();
  }

  /**
   * Serializes `sync-index.json` writes through a single-flight queue so concurrent
   * `TaskPool(6)` workers never produce interleaved partial JSON writes.
   */
  async saveIndex(index: SyncIndex): Promise<void> {
    const serialized = JSON.stringify(index, null, 2);
    const next = this.saveIndexTail
      .catch(() => {
        // Recover queue after prior error
      })
      .then(async () => {
        await this.ensurePrivateDirs();
        await this.app.vault.adapter.write(this.indexPath, serialized);
      });
    this.saveIndexTail = next;
    await next;
  }

  private basePath(driveId: string): string {
    return `${this.basesDir}/${sanitizeBaseId(driveId)}.txt`;
  }

  private prevBasePath(driveId: string): string {
    return `${this.basesDir}/${sanitizeBaseId(driveId)}.prev.txt`;
  }

  async readBase(driveId: string): Promise<string | null> {
    const p = this.basePath(driveId);
    if (!(await this.app.vault.adapter.exists(p))) return null;
    return this.app.vault.adapter.read(p);
  }

  async writeBase(driveId: string, content: string): Promise<void> {
    await this.ensurePrivateDirs();
    await this.app.vault.adapter.write(this.basePath(driveId), content);
  }

  async deleteBase(driveId: string): Promise<void> {
    const p = this.basePath(driveId);
    if (await this.app.vault.adapter.exists(p)) {
      await this.app.vault.adapter.remove(p);
    }
  }

  async readPrevBase(driveId: string): Promise<string | null> {
    const p = this.prevBasePath(driveId);
    if (!(await this.app.vault.adapter.exists(p))) return null;
    return this.app.vault.adapter.read(p);
  }

  async writePrevBase(driveId: string, content: string): Promise<void> {
    await this.ensurePrivateDirs();
    await this.app.vault.adapter.write(this.prevBasePath(driveId), content);
  }

  async deletePrevBase(driveId: string): Promise<void> {
    const p = this.prevBasePath(driveId);
    if (await this.app.vault.adapter.exists(p)) {
      await this.app.vault.adapter.remove(p);
    }
  }
}
