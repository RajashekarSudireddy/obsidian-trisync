import {
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFolder,
  requestUrl,
} from 'obsidian';
import {
  GoogleAuthManager,
  type HttpRequestFn,
} from './auth/googleAuth';
import { GoogleDriveClient } from './drive/driveClient';
import { FirestoreSignalBus } from './signal/firestoreSignal';
import { SyncEngine } from './sync/syncEngine';
import { ObsidianVaultAdapter } from './sync/vaultStore';
import {
  DEFAULT_SETTINGS,
  type SyncStatusState,
  type TriSyncSettings,
} from './types';
import { ActivityModal } from './ui/activityModal';
import { TriSyncSettingTab } from './ui/settingsTab';
import { KeyedDebouncer, generateUuid } from './utils/concurrency';

const SOCKET_RECONNECT_THRESHOLD_MS = 15_000;

function createObsidianHttpRequest(): HttpRequestFn {
  return async (params) => {
    const res = await requestUrl({
      url: params.url,
      method: params.method ?? 'GET',
      headers: params.headers,
      body: params.body,
      throw: false,
    });
    let parsedJson: unknown = undefined;
    try {
      parsedJson = res.json;
    } catch {
      // Binary or non-JSON response
    }
    return {
      status: res.status,
      headers: res.headers ?? {},
      text: res.text ?? '',
      json: parsedJson,
      arrayBuffer: res.arrayBuffer ?? new ArrayBuffer(0),
    };
  };
}

export default class TriSyncPlugin extends Plugin {
  settings!: TriSyncSettings;
  authManager!: GoogleAuthManager;
  driveClient!: GoogleDriveClient;
  signalBus: FirestoreSignalBus | null = null;
  vaultAdapter!: ObsidianVaultAdapter;
  syncEngine!: SyncEngine;
  debouncer!: KeyedDebouncer;

  private vaultReady = false;
  private hiddenAt: number | null = null;
  private statusBarEl: HTMLElement | null = null;
  private statusDotEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.debouncer = new KeyedDebouncer(this.settings.debounceMs);

    // APFS (macOS & iOS) is case-insensitive by default; Android/Linux is case-sensitive.
    const isCaseInsensitiveOs = Platform.isMacOS || Platform.isIosApp || Platform.isWin;
    this.vaultAdapter = new ObsidianVaultAdapter(this.app, {
      pluginId: this.manifest.id,
      caseInsensitive: isCaseInsensitiveOs,
    });

    const httpRequest = createObsidianHttpRequest();
    this.authManager = new GoogleAuthManager({
      tokens: {
        clientId: this.settings.googleClientId,
        clientSecret: this.settings.googleClientSecret,
        refreshToken: this.settings.googleRefreshToken,
        accessToken: this.settings.googleAccessToken,
        tokenExpiresAt: this.settings.googleTokenExpiresAt,
      },
      httpRequest,
      isDesktop: Platform.isDesktopApp,
      onTokensUpdated: async (tokens) => {
        this.settings.googleAccessToken = tokens.accessToken;
        this.settings.googleRefreshToken = tokens.refreshToken;
        this.settings.googleTokenExpiresAt = tokens.tokenExpiresAt;
        await this.saveSettings();
      },
      onAuthCircuitTripped: (reason) => {
        new Notice(
          `TriSync: Google OAuth paused (${reason}). Open Settings -> TriSync to re-authenticate.`,
          12_000
        );
        this.updateStatusBar('auth-error');
      },
    });

    this.driveClient = new GoogleDriveClient({
      auth: this.authManager,
      httpRequest,
    });

    this.syncEngine = new SyncEngine({
      settings: this.settings,
      vault: this.vaultAdapter,
      drive: this.driveClient,
      signalBus: null,
      callbacks: {
        onStatusChange: (status) => this.updateStatusBar(status),
        onConflict: (rec) => {
          new Notice(
            `TriSync conflict saved: ${rec.conflictPath}`,
            8000
          );
        },
        onVaultRootFolderResolved: async (rootFolderId) => {
          this.settings.vaultRootFolderId = rootFolderId;
          await this.saveSettings();
        },
      },
    });

    await this.syncEngine.init();
    this.syncEngine.setPaused(!this.settings.autoSyncEnabled);

    // Echo-suppress 2-step temp rename hops on case-insensitive APFS/Windows
    this.vaultAdapter.setTempRenameHopCallback((oldPath, tempPath, newPath) => {
      const sup = this.syncEngine.getEchoSuppressor();
      sup.recordRename(oldPath, tempPath);
      sup.recordRename(tempPath, newPath);
    });

    // UI chrome: settings tab, ribbon, status bar, commands
    this.addSettingTab(new TriSyncSettingTab(this.app, this));

    this.addRibbonIcon('refresh-cw', 'TriSync: Sync Now', async () => {
      await this.triggerManualSync();
    });

    if (Platform.isDesktopApp) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass('trisync-status-bar');
      this.statusDotEl = this.statusBarEl.createSpan({ cls: 'trisync-status-dot is-idle' });
      this.statusTextEl = this.statusBarEl.createSpan({ text: 'TriSync' });
      this.statusBarEl.addEventListener('click', () => this.openActivityModal());
    }

    this.registerCommands();
    this.registerLifecycleListeners();

    // Gate vault watchers strictly until Obsidian finishes initial layout + vault scan!
    // Prevents the startup `vault.on('create')` flood across every existing file (P0 #7).
    this.app.workspace.onLayoutReady(async () => {
      // Yield one tick after layout ready before opening watcher gate
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.vaultReady = true;
      this.registerVaultWatchers();

      if (this.settings.autoSyncEnabled && this.authManager.isConfigured()) {
        await this.reconnectSignalBus().catch(() => {
          // Firestore is optional accelerator; Drive fallback remains active
        });
        void this.syncEngine.onResume();
      }
    });

    // Periodic fallback delta sync (covers extended Firestore outages)
    this.registerInterval(
      window.setInterval(() => {
        if (!this.vaultReady || !this.settings.autoSyncEnabled || !this.authManager.isConfigured()) {
          return;
        }
        void this.syncEngine.runDeltaSync().catch(() => {
          // Logged inside SyncEngine
        });
      }, Math.max(1, this.settings.syncIntervalMinutes) * 60_000)
    );
  }

  onunload(): void {
    this.vaultReady = false;
    this.debouncer?.clear();
    this.syncEngine?.dispose();
    this.authManager?.dispose();
    if (this.signalBus) {
      const bus = this.signalBus;
      this.signalBus = null;
      // Clean Firebase teardown (`terminate(db)` + `deleteApp(app)`)
      void bus.disconnect();
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'trisync-sync-now',
      name: 'Sync Now (Delta Sync)',
      callback: async () => {
        await this.triggerManualSync();
      },
    });

    this.addCommand({
      id: 'trisync-full-reconcile',
      name: 'Run Full Vault Reconcile',
      callback: async () => {
        if (!this.authManager.isConfigured()) {
          new Notice('TriSync: Configure Google Drive credentials in Settings first.');
          return;
        }
        try {
          await this.debouncer.flushAll();
          await this.syncEngine.fullReconcile();
          new Notice('TriSync: Full reconcile complete.');
        } catch (err) {
          new Notice(`TriSync reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.addCommand({
      id: 'trisync-open-activity',
      name: 'Show Sync Activity & Conflicts',
      callback: () => this.openActivityModal(),
    });

    this.addCommand({
      id: 'trisync-toggle-pause',
      name: 'Pause / Resume Automatic Sync',
      callback: async () => {
        const nextPaused = !this.syncEngine.isPaused();
        this.syncEngine.setPaused(nextPaused);
        this.settings.autoSyncEnabled = !nextPaused;
        await this.saveSettings();
        new Notice(nextPaused ? 'TriSync paused.' : 'TriSync resumed.');
      },
    });
  }

  private registerVaultWatchers(): void {
    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (!this.vaultReady) return;
        if (!this.authManager.isConfigured()) return;
        if (file instanceof TFolder) {
          void this.syncEngine.handleLocalFolderCreate(file.path).catch(() => {});
          return;
        }
        // Immediate (0ms) for creates
        void this.syncEngine.handleLocalCreateOrModify(file.path).catch(() => {});
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!this.vaultReady || file instanceof TFolder) return;
        if (!this.authManager.isConfigured()) return;
        // Debounced for typing edits (flushed immediately on hidden / leaf change)
        this.debouncer.schedule(file.path, () =>
          this.syncEngine.handleLocalCreateOrModify(file.path)
        );
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!this.vaultReady) return;
        if (!this.authManager.isConfigured()) return;
        if (file instanceof TFolder) {
          void this.syncEngine.handleLocalFolderDelete(file.path).catch(() => {});
          return;
        }
        this.debouncer.cancel(file.path);
        // Immediate (0ms) for deletes
        void this.syncEngine.handleLocalDelete(file.path).catch(() => {});
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!this.vaultReady) return;
        if (!this.authManager.isConfigured()) return;
        const isFolder = file instanceof TFolder;
        this.debouncer.cancel(oldPath);
        // Immediate (0ms) for renames (handles all 4 ignore transitions + TFolder cascade suppression)
        void this.syncEngine.handleLocalRename(oldPath, file.path, isFolder).catch(() => {});
      })
    );
  }

  private registerLifecycleListeners(): void {
    // Track active typing timestamp for 1.5s remote-write deferral (P0 #7)
    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.vaultAdapter.recordActiveEditorEdit(activeFile.path, Date.now());
        }
      })
    );

    // Flush typing debouncer immediately when user switches tabs/notes (P1 #3)
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        if (!this.vaultReady) return;
        void this.debouncer.flushAll();
      })
    );

    // Mobile & Desktop visibilitychange hooks (P1 #3 + P1 #4)
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!this.vaultReady) return;

      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
        // Flush pending edits IMMEDIATELY before iOS/Android freezes WKWebView!
        void this.debouncer.flushAll();
        return;
      }

      if (document.visibilityState === 'visible') {
        const backgroundMs = this.hiddenAt !== null ? Date.now() - this.hiddenAt : 0;
        this.hiddenAt = null;

        if (!this.settings.autoSyncEnabled || !this.authManager.isConfigured()) return;

        // Tear down zombie half-open Firestore TCP sockets after >15s backgrounding!
        if (backgroundMs > SOCKET_RECONNECT_THRESHOLD_MS && this.signalBus?.isConnected()) {
          void this.signalBus.reconnectNetwork();
        }
        // Immediately fire delta sync & flush offline queue
        void this.syncEngine.onResume();
      }
    });

    this.registerDomEvent(window, 'online', () => {
      if (!this.vaultReady || !this.settings.autoSyncEnabled || !this.authManager.isConfigured()) {
        return;
      }
      if (this.signalBus?.isConnected()) {
        void this.signalBus.reconnectNetwork();
      } else {
        void this.reconnectSignalBus().catch(() => {});
      }
      void this.syncEngine.onResume();
    });

    this.registerDomEvent(window, 'focus', () => {
      if (!this.vaultReady || !this.settings.autoSyncEnabled || !this.authManager.isConfigured()) {
        return;
      }
      void this.syncEngine.onResume();
    });
  }

  async runDesktopGoogleSignIn(): Promise<void> {
    this.authManager.updateCredentials({
      clientId: this.settings.googleClientId,
      clientSecret: this.settings.googleClientSecret,
    });
    const tokens = await this.authManager.startDesktopOAuthFlow((url) => {
      window.open(url, '_blank');
    });
    this.settings.googleAccessToken = tokens.accessToken;
    this.settings.googleRefreshToken = tokens.refreshToken;
    this.settings.googleTokenExpiresAt = tokens.tokenExpiresAt;
    await this.saveSettings();
    await this.ensureVaultRootFolderForExport().catch(() => {});
  }

  /**
   * Ensures `settings.vaultRootFolderId` is resolved on Drive before exporting a Setup Bundle
   * so mobile devices never receive an empty root folder ID.
   */
  async ensureVaultRootFolderForExport(): Promise<void> {
    if (this.settings.vaultRootFolderId || !this.authManager.isConfigured()) {
      return;
    }
    const rootId = await this.driveClient.ensureVaultRootFolder(
      this.settings.vaultName || 'ObsidianVault'
    );
    this.settings.vaultRootFolderId = rootId;
    await this.saveSettings();
  }

  async reconnectSignalBus(): Promise<void> {
    if (this.signalBus) {
      this.syncEngine.attachSignalBus(null);
      await this.signalBus.disconnect();
      this.signalBus = null;
    }

    if (
      !this.settings.firebaseConfig ||
      !this.settings.firebaseEmail ||
      !this.settings.firebasePassword ||
      !this.settings.vaultId
    ) {
      return;
    }

    const indexSnap = this.syncEngine.getIndexSnapshot();
    const bus = new FirestoreSignalBus({
      firebaseConfig: this.settings.firebaseConfig,
      email: this.settings.firebaseEmail,
      password: this.settings.firebasePassword,
      vaultId: this.settings.vaultId,
      deviceId: this.settings.deviceId,
      forceLongPolling: this.settings.forceLongPolling,
      initialLastSeenSeq: indexSnap.lastSeenSignalSeq,
      initialLastSeenPulseId: indexSnap.lastSeenPulseId,
    });

    await bus.connect();
    this.signalBus = bus;
    this.syncEngine.attachSignalBus(bus);
  }

  async reinitializeServices(): Promise<void> {
    this.authManager.updateCredentials({
      clientId: this.settings.googleClientId,
      clientSecret: this.settings.googleClientSecret,
      refreshToken: this.settings.googleRefreshToken,
      accessToken: this.settings.googleAccessToken,
      tokenExpiresAt: this.settings.googleTokenExpiresAt,
    });
    const currentIndexRoot = this.syncEngine.getIndexSnapshot().vaultRootFolderId;
    if (
      currentIndexRoot &&
      this.settings.vaultRootFolderId &&
      currentIndexRoot !== this.settings.vaultRootFolderId
    ) {
      await this.syncEngine.resetForNewVaultRoot(this.settings.vaultRootFolderId);
    }
    this.syncEngine.updateSettings(this.settings);
    this.debouncer.setDefaultDelay(this.settings.debounceMs);
    await this.reconnectSignalBus().catch(() => {});
  }

  async triggerManualSync(): Promise<void> {
    if (!this.authManager.isConfigured()) {
      new Notice('TriSync: Configure Google Drive credentials in Settings first.');
      return;
    }
    try {
      await this.debouncer.flushAll();
      await this.syncEngine.flushOfflineQueue();
      await this.syncEngine.runDeltaSync();
      new Notice('TriSync: Vault synced.');
    } catch (err) {
      new Notice(`TriSync sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  openActivityModal(): void {
    new ActivityModal(
      this.app,
      this.syncEngine,
      () => `${this.settings.deviceName} (${this.settings.deviceId.slice(0, 8)})`,
      () => Boolean(this.signalBus?.isConnected()),
      () => this.authManager.isCircuitOpen(),
      () => this.triggerManualSync(),
      (path) => this.vaultAdapter.findExistingPath(path)
    ).open();
  }

  private updateStatusBar(status: SyncStatusState): void {
    if (!this.statusDotEl || !this.statusTextEl) return;
    this.statusDotEl.className = `trisync-status-dot is-${status}`;
    const labels: Record<SyncStatusState, string> = {
      idle: 'TriSync',
      syncing: 'TriSync: Syncing…',
      offline: 'TriSync: Offline',
      'auth-error': 'TriSync: Auth Error',
      paused: 'TriSync: Paused',
    };
    this.statusTextEl.setText(labels[status]);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<TriSyncSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {}),
      ignorePatterns: Array.isArray(loaded?.ignorePatterns)
        ? loaded!.ignorePatterns
        : [...DEFAULT_SETTINGS.ignorePatterns],
    };

    let mutated = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = generateUuid();
      mutated = true;
    }
    if (!this.settings.vaultId) {
      this.settings.vaultId = generateUuid();
      mutated = true;
    }
    if (!loaded?.vaultName) {
      const vaultName = this.app.vault.getName?.();
      if (vaultName) {
        this.settings.vaultName = vaultName;
        mutated = true;
      }
    }
    if (!loaded?.deviceName) {
      if (Platform.isIosApp) this.settings.deviceName = 'iPhone';
      else if (Platform.isAndroidApp) this.settings.deviceName = 'Android';
      else if (Platform.isMacOS) this.settings.deviceName = 'MacBook';
      else this.settings.deviceName = 'Desktop';
      mutated = true;
    }

    if (mutated) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.syncEngine?.updateSettings(this.settings);
    this.authManager?.updateCredentials({
      clientId: this.settings.googleClientId,
      clientSecret: this.settings.googleClientSecret,
      refreshToken: this.settings.googleRefreshToken,
      accessToken: this.settings.googleAccessToken,
      tokenExpiresAt: this.settings.googleTokenExpiresAt,
    });
  }
}
