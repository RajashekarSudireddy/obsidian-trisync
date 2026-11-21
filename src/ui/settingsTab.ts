import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import {
  exportEncryptedSetupBundle,
  importEncryptedSetupBundle,
} from '../auth/googleAuth';
import type { FirebaseWebConfig, TriSyncSettings } from '../types';
import type TriSyncPlugin from '../main';

class ExportBundleModal extends Modal {
  private pin = '';

  constructor(
    app: App,
    private readonly settings: TriSyncSettings,
    private readonly ensureRootFolderId?: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Export PIN-Encrypted Setup Bundle' });
    contentEl.createEl('p', {
      text: 'Encrypts your Google Drive OAuth, Vault Root Folder ID, and Firebase config with AES-256-GCM + PBKDF2 so raw secrets never sit in clipboard history. Device ID is excluded automatically.',
      cls: 'setting-item-description',
    });

    let outputArea: HTMLTextAreaElement;

    new Setting(contentEl)
      .setName('One-time PIN (min 4 chars)')
      .setDesc('Enter the same PIN when importing on iPhone or Android.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('e.g. 849201');
        text.onChange((val) => {
          this.pin = val;
        });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Encrypt & Copy to Clipboard')
        .setCta()
        .onClick(async () => {
          try {
            if (this.ensureRootFolderId) {
              await this.ensureRootFolderId();
            }
            const encrypted = await exportEncryptedSetupBundle(this.settings, this.pin);
            outputArea.value = encrypted;
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(encrypted);
              new Notice('Encrypted Setup Bundle copied to clipboard!');
            } else {
              new Notice('Encrypted Setup Bundle generated below — copy it manually.');
            }
          } catch (err) {
            new Notice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
    );

    outputArea = contentEl.createEl('textarea', {
      cls: 'trisync-textarea',
      attr: { readonly: 'true', placeholder: 'TRISYNC1:... encrypted bundle appears here' },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ImportBundleModal extends Modal {
  private bundleText = '';
  private pin = '';

  constructor(
    app: App,
    private readonly onImported: (
      imported: Awaited<ReturnType<typeof importEncryptedSetupBundle>>
    ) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Import PIN-Encrypted Setup Bundle' });
    contentEl.createEl('p', {
      text: 'Paste the TRISYNC1:... bundle exported from your MacBook and enter the PIN. A fresh unique Device ID will be generated for this device.',
      cls: 'setting-item-description',
    });

    const area = contentEl.createEl('textarea', {
      cls: 'trisync-textarea',
      attr: { placeholder: 'Paste TRISYNC1:... bundle here' },
    });
    area.addEventListener('input', () => {
      this.bundleText = area.value;
    });

    new Setting(contentEl)
      .setName('Decryption PIN')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Enter PIN');
        text.onChange((val) => {
          this.pin = val;
        });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Decrypt & Apply')
        .setCta()
        .onClick(async () => {
          try {
            const result = await importEncryptedSetupBundle(this.bundleText, this.pin);
            await this.onImported(result);
            new Notice('Setup Bundle imported! New Device ID assigned.');
            this.close();
          } catch (err) {
            new Notice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class TriSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TriSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl('h2', { text: 'TriSync — Google Drive + Firestore Real-Time Sync' });

    if (this.plugin.authManager.isCircuitOpen()) {
      const banner = containerEl.createDiv({ cls: 'trisync-banner is-error' });
      banner.createEl('strong', { text: 'Google OAuth Paused (invalid_grant): ' });
      banner.createSpan({
        text: `${this.plugin.authManager.getCircuitReason()}. Ensure your GCP OAuth Consent Screen is in Production mode and sign in again.`,
      });
    } else if (this.plugin.authManager.isConfigured()) {
      const banner = containerEl.createDiv({ cls: 'trisync-banner is-success' });
      banner.setText(
        `Google Drive connected · Vault Root ID: ${s.vaultRootFolderId || '(pending initial sync)'} · Firestore: ${this.plugin.signalBus?.isConnected() ? 'Live' : 'Disconnected (Drive fallback)'}`
      );
    }

    // --- Device & Vault ---
    containerEl.createEl('h3', { text: 'Device & Vault Identity' });

    new Setting(containerEl)
      .setName('Device name')
      .setDesc(`Friendly name used in conflict copies (Device ID: ${s.deviceId}).`)
      .addText((text) =>
        text
          .setPlaceholder('MacBook / iPhone / Android')
          .setValue(s.deviceName)
          .onChange(async (val) => {
            s.deviceName = val.trim() || 'My Device';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Vault name (Drive folder)')
      .setDesc('Synced under My Drive/ObsidianSync/<VaultName>/.')
      .addText((text) =>
        text
          .setPlaceholder('MainVault')
          .setValue(s.vaultName)
          .onChange(async (val) => {
            s.vaultName = val.trim() || 'ObsidianVault';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Vault ID (Firestore signal doc)')
      .setDesc('Shared identifier across all devices syncing this vault.')
      .addText((text) =>
        text.setValue(s.vaultId).onChange(async (val) => {
          s.vaultId = val.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Vault Root Folder ID')
      .setDesc('Populated automatically on first sync and shared via Setup Bundle to prevent duplicate Drive folders.')
      .addText((text) =>
        text
          .setPlaceholder('Auto-resolved on initial sync')
          .setValue(s.vaultRootFolderId)
          .onChange(async (val) => {
            s.vaultRootFolderId = val.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Mobile Onboarding (Setup Bundle) ---
    containerEl.createEl('h3', { text: 'Mobile Onboarding (PIN-Encrypted Setup Bundle)' });

    new Setting(containerEl)
      .setName('Setup Bundle')
      .setDesc(
        'Sign in once on MacBook, export a PIN-encrypted bundle, and import it on iPhone & Android.'
      )
      .addButton((btn) =>
        btn.setButtonText('Export Setup Bundle').onClick(() => {
          new ExportBundleModal(this.app, s, () =>
            this.plugin.ensureVaultRootFolderForExport()
          ).open();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText('Import Setup Bundle')
          .setCta()
          .onClick(() => {
            new ImportBundleModal(this.app, async ({ payload, newDeviceId }) => {
              const previousRootId = s.vaultRootFolderId;
              s.vaultId = payload.vaultId || s.vaultId;
              s.vaultName = payload.vaultName || s.vaultName;
              s.vaultRootFolderId = payload.vaultRootFolderId;
              s.googleClientId = payload.googleClientId;
              s.googleClientSecret = payload.googleClientSecret;
              s.googleRefreshToken = payload.googleRefreshToken;
              s.googleAccessToken = '';
              s.googleTokenExpiresAt = 0;
              s.firebaseConfig = payload.firebaseConfig;
              s.firebaseEmail = payload.firebaseEmail;
              s.firebasePassword = payload.firebasePassword;
              s.ignorePatterns = payload.ignorePatterns;
              s.maxAttachmentSizeMB = payload.maxAttachmentSizeMB;
              // Always assign fresh unique per-device ID!
              s.deviceId = newDeviceId;

              if (
                previousRootId &&
                payload.vaultRootFolderId &&
                previousRootId !== payload.vaultRootFolderId
              ) {
                await this.plugin.syncEngine.resetForNewVaultRoot(
                  payload.vaultRootFolderId
                );
              }
              await this.plugin.saveSettings();
              await this.plugin.reinitializeServices();
              this.display();
            }).open();
          })
      );

    // --- Google Drive OAuth ---
    containerEl.createEl('h3', { text: 'Google Drive API v3 (drive.file)' });

    new Setting(containerEl)
      .setName('Google OAuth Client ID')
      .setDesc('Desktop app OAuth client from Google Cloud Console (Production mode).')
      .addText((text) =>
        text.setValue(s.googleClientId).onChange(async (val) => {
          s.googleClientId = val.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Google OAuth Client Secret')
      .setDesc('Required by Google for Desktop OAuth token/refresh endpoints alongside PKCE.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(s.googleClientSecret).onChange(async (val) => {
          s.googleClientSecret = val.trim();
          await this.plugin.saveSettings();
        });
      });

    const authSetting = new Setting(containerEl)
      .setName('Google Drive authorization')
      .setDesc(
        Platform.isDesktopApp
          ? 'Opens your browser to authenticate via temporary 127.0.0.1 loopback (120s timeout).'
          : 'On mobile, use Import Setup Bundle above to transfer your MacBook credentials securely.'
      );

    if (Platform.isDesktopApp) {
      authSetting.addButton((btn) =>
        btn
          .setButtonText(s.googleRefreshToken ? 'Re-authenticate Google Drive' : 'Sign in with Google')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.runDesktopGoogleSignIn();
              new Notice('Google Drive connected successfully!');
              this.display();
            } catch (err) {
              new Notice(`Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              btn.setDisabled(false);
            }
          })
      );
    }

    if (this.plugin.authManager.isCircuitOpen()) {
      authSetting.addButton((btn) =>
        btn.setButtonText('Reset Auth Breaker').onClick(() => {
          this.plugin.authManager.resetCircuit();
          this.display();
        })
      );
    }

    if (s.googleRefreshToken) {
      authSetting.addButton((btn) =>
        btn
          .setButtonText('Sign Out')
          .setWarning()
          .onClick(async () => {
            s.googleRefreshToken = '';
            s.googleAccessToken = '';
            s.googleTokenExpiresAt = 0;
            await this.plugin.saveSettings();
            this.plugin.authManager.updateCredentials({
              refreshToken: '',
              accessToken: '',
              tokenExpiresAt: 0,
            });
            new Notice('Signed out of Google Drive.');
            this.display();
          })
      );
    }

    // --- Firebase Firestore Signal Bus ---
    containerEl.createEl('h3', { text: 'Firebase Firestore Real-Time Signal (Spark Free Tier)' });

    new Setting(containerEl)
      .setName('Firebase Web Config JSON')
      .setDesc('Paste the JSON object from Firebase Project Settings -> Web App.')
      .addTextArea((area) => {
        area.inputEl.addClass('trisync-textarea');
        area.setPlaceholder('{"apiKey":"...","projectId":"...","appId":"..."}');
        area.setValue(s.firebaseConfig ? JSON.stringify(s.firebaseConfig, null, 2) : '');
        area.onChange(async (val) => {
          const trimmed = val.trim();
          if (!trimmed) {
            s.firebaseConfig = null;
            await this.plugin.saveSettings();
            return;
          }
          try {
            const parsed = JSON.parse(trimmed) as FirebaseWebConfig;
            if (parsed.apiKey && parsed.projectId) {
              s.firebaseConfig = parsed;
              await this.plugin.saveSettings();
            }
          } catch {
            // Wait until valid JSON is finished
          }
        });
      });

    new Setting(containerEl)
      .setName('Firebase Auth Email')
      .addText((text) =>
        text.setValue(s.firebaseEmail).onChange(async (val) => {
          s.firebaseEmail = val.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Firebase Auth Password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(s.firebasePassword).onChange(async (val) => {
          s.firebasePassword = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Force Firestore long polling')
      .setDesc('Enable if a corporate proxy or iOS network blocks WebChannel streaming.')
      .addToggle((toggle) =>
        toggle.setValue(s.forceLongPolling).onChange(async (val) => {
          s.forceLongPolling = val;
          await this.plugin.saveSettings();
          await this.plugin.reconnectSignalBus();
        })
      );

    new Setting(containerEl)
      .setName('Reconnect Firestore Signal Bus')
      .addButton((btn) =>
        btn.setButtonText('Connect / Test').onClick(async () => {
          try {
            await this.plugin.reconnectSignalBus();
            new Notice('Firestore real-time signal connected!');
            this.display();
          } catch (err) {
            new Notice(`Firestore connection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
      );

    // --- Sync Preferences ---
    containerEl.createEl('h3', { text: 'Sync Preferences' });

    new Setting(containerEl)
      .setName('Enable automatic sync')
      .addToggle((toggle) =>
        toggle.setValue(s.autoSyncEnabled).onChange(async (val) => {
          s.autoSyncEnabled = val;
          await this.plugin.saveSettings();
          this.plugin.syncEngine.setPaused(!val);
        })
      );

    new Setting(containerEl)
      .setName('Typing debounce (ms)')
      .setDesc('Delay before uploading note edits (flushed immediately on app switch or background).')
      .addText((text) =>
        text.setValue(String(s.debounceMs)).onChange(async (val) => {
          const parsed = Number(val);
          if (!Number.isNaN(parsed) && parsed >= 100 && parsed <= 10000) {
            s.debounceMs = parsed;
            this.plugin.debouncer.setDefaultDelay(parsed);
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Max attachment size (MB)')
      .setDesc('Files larger than this are skipped to protect mobile WKWebView memory (default 50 MB).')
      .addText((text) =>
        text.setValue(String(s.maxAttachmentSizeMB)).onChange(async (val) => {
          const parsed = Number(val);
          if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 500) {
            s.maxAttachmentSizeMB = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Ignore patterns (one glob per line)')
      .setDesc('Paths matching these globs are never synced.')
      .addTextArea((area) => {
        area.inputEl.addClass('trisync-textarea');
        area.setValue(s.ignorePatterns.join('\n'));
        area.onChange(async (val) => {
          s.ignorePatterns = val
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Manual sync actions')
      .addButton((btn) =>
        btn
          .setButtonText('Run Full Reconcile')
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.syncEngine.fullReconcile();
              new Notice('TriSync full reconcile complete.');
              this.display();
            } catch (err) {
              new Notice(`Reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Open Activity Log').onClick(() => {
          this.plugin.openActivityModal();
        })
      );
  }
}
