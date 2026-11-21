import { App, Modal, Notice } from 'obsidian';
import type { SyncEngine } from '../sync/syncEngine';

/**
 * Live Sync Activity, Latency & Clickable Conflicts Modal.
 */
export class ActivityModal extends Modal {
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: App,
    private readonly engine: SyncEngine,
    private readonly getDeviceLabel: () => string,
    private readonly isSignalConnected: () => boolean,
    private readonly isAuthCircuitOpen: () => boolean,
    private readonly onSyncNow: () => Promise<void>,
    private readonly resolveVaultPath?: (path: string) => Promise<string | null>
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    this.refreshInterval = setInterval(() => this.render(), 1500);
  }

  onClose(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'TriSync Activity & Conflicts' });

    const summary = contentEl.createDiv({ cls: 'trisync-modal-summary' });
    this.addStatCard(summary, 'Device', this.getDeviceLabel());
    this.addStatCard(summary, 'Status', this.engine.getStatus().toUpperCase());
    this.addStatCard(
      summary,
      'Real-Time Pulse',
      this.isSignalConnected() ? 'Connected (Firestore)' : 'Fallback (Drive Delta)'
    );
    const lastSync = this.engine.getLastSyncTime();
    this.addStatCard(
      summary,
      'Last Sync',
      lastSync > 0 ? new Date(lastSync).toLocaleTimeString() : 'Never'
    );

    if (this.isAuthCircuitOpen()) {
      const warn = contentEl.createDiv({ cls: 'trisync-banner is-error' });
      warn.setText(
        'Google Drive authentication circuit breaker is OPEN (invalid_grant). Re-authenticate in Settings -> TriSync.'
      );
    }

    // Conflicts section
    const conflicts = this.engine.getConflicts();
    contentEl.createEl('h3', { text: `Conflicts (${conflicts.length})` });
    if (conflicts.length === 0) {
      contentEl.createEl('p', {
        text: 'No conflicts recorded in this session.',
        cls: 'setting-item-description',
      });
    } else {
      const list = contentEl.createEl('ul', { cls: 'trisync-conflict-list' });
      for (const c of conflicts) {
        const li = list.createEl('li', { cls: 'trisync-conflict-item' });
        const link = li.createEl('a', {
          text: c.conflictPath,
          cls: 'trisync-conflict-link',
        });
        link.addEventListener('click', (evt) => {
          evt.preventDefault();
          void this.openConflictFile(c.conflictPath);
        });
        li.createSpan({
          text: `${c.reason} · ${new Date(c.timestamp).toLocaleTimeString()}`,
          cls: 'setting-item-description',
        });
      }
    }

    // Activity Log section
    const logs = this.engine.getActivityLog();
    contentEl.createEl('h3', { text: `Recent Activity (${logs.length})` });
    const logContainer = contentEl.createDiv({ cls: 'trisync-log-list' });

    if (logs.length === 0) {
      logContainer.createDiv({ text: 'No sync events yet.' });
    } else {
      for (const entry of logs) {
        const row = logContainer.createDiv({
          cls: `trisync-log-row is-${entry.level}`,
        });
        const meta = row.createDiv({ cls: 'trisync-log-meta' });
        const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : '';
        meta.createSpan({ text: `[${entry.action}]${dur}` });
        meta.createSpan({ text: new Date(entry.timestamp).toLocaleTimeString() });
        const msg = entry.path ? `${entry.path}: ${entry.detail}` : entry.detail;
        row.createDiv({ text: msg });
      }
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'trisync-modal-actions' });
    const clearBtn = actions.createEl('button', { text: 'Clear Log' });
    clearBtn.addEventListener('click', () => {
      this.engine.clearActivityLog();
      this.render();
    });

    const syncBtn = actions.createEl('button', {
      text: 'Sync Now',
      cls: 'mod-cta',
    });
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      try {
        await this.onSyncNow();
      } finally {
        syncBtn.disabled = false;
        this.render();
      }
    });
  }

  private addStatCard(parent: HTMLElement, label: string, value: string): void {
    const card = parent.createDiv({ cls: 'trisync-stat-card' });
    card.createDiv({ cls: 'trisync-stat-label', text: label });
    card.createDiv({ cls: 'trisync-stat-value', text: value });
  }

  private async openConflictFile(path: string): Promise<void> {
    const resolved = this.resolveVaultPath
      ? await this.resolveVaultPath(path)
      : (this.app.vault.getAbstractFileByPath(path)?.path ??
          this.app.vault.getAbstractFileByPath(path.normalize('NFD'))?.path ??
          null);
    if (!resolved) {
      new Notice(`Conflict file not found: ${path}`);
      return;
    }
    await this.app.workspace.openLinkText(resolved, '', false);
    this.close();
  }
}
