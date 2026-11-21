import { foldPath, normalizePath } from './ignore';

interface WriteEcho {
  md5: string;
  expiresAt: number;
}

interface DeleteEcho {
  expiresAt: number;
}

interface RenameEcho {
  oldPath: string;
  newPath: string;
  expiresAt: number;
}

interface FolderRenameEcho {
  oldPrefix: string;
  newPrefix: string;
  expiresAt: number;
}

/**
 * Suppresses vault watcher echoes caused by TriSync's own remote pulls
 * across `write`, `delete`, `rename`, and `TFolder` child-rename cascades.
 */
export class EchoSuppressor {
  private readonly writes = new Map<string, WriteEcho>();
  private readonly deletes = new Map<string, DeleteEcho>();
  private readonly folderCreates = new Map<string, DeleteEcho>();
  private readonly renames: RenameEcho[] = [];
  private readonly folderRenames: FolderRenameEcho[] = [];

  constructor(
    private readonly defaultTtlMs: number = 10_000,
    private readonly caseInsensitive: boolean = false,
    private readonly now: () => number = () => Date.now()
  ) {}

  private key(rawPath: string): string {
    return this.caseInsensitive ? foldPath(rawPath) : normalizePath(rawPath);
  }

  recordWrite(rawPath: string, md5: string, ttlMs: number = this.defaultTtlMs): void {
    this.prune();
    this.writes.set(this.key(rawPath), {
      md5,
      expiresAt: this.now() + ttlMs,
    });
  }

  consumeWrite(rawPath: string, currentMd5: string): boolean {
    this.prune();
    const k = this.key(rawPath);
    const entry = this.writes.get(k);
    if (!entry) return false;
    if (entry.md5 === currentMd5) {
      this.writes.delete(k);
      return true;
    }
    return false;
  }

  hasPendingWrite(rawPath: string): boolean {
    this.prune();
    return this.writes.has(this.key(rawPath));
  }

  recordDelete(rawPath: string, ttlMs: number = this.defaultTtlMs): void {
    this.prune();
    this.deletes.set(this.key(rawPath), {
      expiresAt: this.now() + ttlMs,
    });
  }

  consumeDelete(rawPath: string): boolean {
    this.prune();
    const k = this.key(rawPath);
    const entry = this.deletes.get(k);
    if (!entry) return false;
    this.deletes.delete(k);
    return true;
  }

  recordFolderCreate(rawFolderPath: string, ttlMs: number = this.defaultTtlMs): void {
    this.prune();
    this.folderCreates.set(this.key(rawFolderPath), {
      expiresAt: this.now() + ttlMs,
    });
  }

  consumeFolderCreate(rawFolderPath: string): boolean {
    this.prune();
    const k = this.key(rawFolderPath);
    const entry = this.folderCreates.get(k);
    if (!entry) return false;
    this.folderCreates.delete(k);
    return true;
  }

  recordRename(
    rawOldPath: string,
    rawNewPath: string,
    ttlMs: number = this.defaultTtlMs
  ): void {
    this.prune();
    this.renames.push({
      oldPath: this.key(rawOldPath),
      newPath: this.key(rawNewPath),
      expiresAt: this.now() + ttlMs,
    });
  }

  /**
   * Records a folder rename so both the folder rename event itself and all
   * descendant `TFile` rename events fired by Obsidian are suppressed.
   */
  recordFolderRename(
    rawOldFolder: string,
    rawNewFolder: string,
    ttlMs: number = this.defaultTtlMs
  ): void {
    this.prune();
    const oldNorm = this.key(rawOldFolder);
    const newNorm = this.key(rawNewFolder);
    this.renames.push({
      oldPath: oldNorm,
      newPath: newNorm,
      expiresAt: this.now() + ttlMs,
    });
    this.folderRenames.push({
      oldPrefix: oldNorm + '/',
      newPrefix: newNorm + '/',
      expiresAt: this.now() + ttlMs,
    });
  }

  consumeRename(rawOldPath: string, rawNewPath: string): boolean {
    this.prune();
    const oldK = this.key(rawOldPath);
    const newK = this.key(rawNewPath);

    const exactIdx = this.renames.findIndex(
      (r) => r.oldPath === oldK && r.newPath === newK
    );
    if (exactIdx !== -1) {
      this.renames.splice(exactIdx, 1);
      return true;
    }

    // Check child file cascade from a recorded folder rename
    for (const fr of this.folderRenames) {
      if (oldK.startsWith(fr.oldPrefix) && newK.startsWith(fr.newPrefix)) {
        const oldSuffix = oldK.slice(fr.oldPrefix.length);
        const newSuffix = newK.slice(fr.newPrefix.length);
        if (oldSuffix === newSuffix) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Checks whether a child file rename corresponds to a local TFolder rename
   * that is already being handled by a single Drive folder PATCH.
   */
  isSuppressedFolderChildRename(rawOldPath: string, rawNewPath: string): boolean {
    this.prune();
    const oldK = this.key(rawOldPath);
    const newK = this.key(rawNewPath);
    for (const fr of this.folderRenames) {
      if (oldK.startsWith(fr.oldPrefix) && newK.startsWith(fr.newPrefix)) {
        if (oldK.slice(fr.oldPrefix.length) === newK.slice(fr.newPrefix.length)) {
          return true;
        }
      }
    }
    return false;
  }

  clear(): void {
    this.writes.clear();
    this.deletes.clear();
    this.folderCreates.clear();
    this.renames.length = 0;
    this.folderRenames.length = 0;
  }

  private prune(): void {
    const current = this.now();
    for (const [k, v] of this.writes.entries()) {
      if (v.expiresAt <= current) this.writes.delete(k);
    }
    for (const [k, v] of this.deletes.entries()) {
      if (v.expiresAt <= current) this.deletes.delete(k);
    }
    for (const [k, v] of this.folderCreates.entries()) {
      if (v.expiresAt <= current) this.folderCreates.delete(k);
    }
    for (let i = this.renames.length - 1; i >= 0; i--) {
      if (this.renames[i].expiresAt <= current) this.renames.splice(i, 1);
    }
    for (let i = this.folderRenames.length - 1; i >= 0; i--) {
      if (this.folderRenames[i].expiresAt <= current) this.folderRenames.splice(i, 1);
    }
  }
}
