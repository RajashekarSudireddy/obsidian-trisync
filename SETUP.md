# TriSync (`obsidian-trisync`) Setup Guide

This guide walks you through setting up **Google Drive API v3 (`drive.file`)** and **Firebase Firestore (Spark Free Tier — $0/month, no credit card)** so your Obsidian vault syncs in ~1–2 seconds across **macOS**, **iOS**, and **Android**.

---

## 1. Google Cloud Project & Drive API v3

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a personal project (e.g. `my-obsidian-trisync`).
2. Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.

### 1.1 Configure OAuth Consent Screen (**Production Mode**)

> **CRITICAL — Avoid 7-Day Refresh Token Expiration**
> OAuth apps left in **Testing** mode automatically expire refresh tokens every **7 days**. Because TriSync only uses the narrow, non-sensitive `drive.file` scope for your personal account, you should publish your OAuth app to **In Production** — you do **not** need Google public verification.

1. Go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Branding / Audience**).
2. Choose **External** user type.
3. Fill in an app name (e.g. `TriSync Personal`) and your personal email for support & developer contact.
4. Add the single scope:
   - `https://www.googleapis.com/auth/drive.file`
5. Go to **Audience** and click **Publish App** to switch status to **In Production**.
   - During MacBook sign-in, Google will show an *"App isn't verified"* warning screen because it is your private personal OAuth app. Click **Advanced → Go to TriSync Personal (unsafe) → Continue** once. Your refresh token will then stay valid indefinitely across Mac, iPhone, and Android.

### 1.2 Create a Desktop OAuth Client

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app** (required so Google permits ephemeral loopback redirects `http://127.0.0.1:<port>/callback`).
3. Copy both:
   - **Client ID**
   - **Client Secret** *(required by Google's Desktop OAuth token/refresh endpoints even alongside PKCE)*

### 1.3 Important `drive.file` Visibility Caveat

Because TriSync requests only the least-privilege `drive.file` scope:
- TriSync can **only** see folders and files created or opened by your `client_id`.
- **Do not manually create or upload files/folders into `My Drive/ObsidianSync/<VaultName>/` using the Google Drive web UI** — Google Drive's API will hide manually uploaded files from `drive.file` clients. Always add/edit files inside Obsidian on Mac, iPhone, or Android so TriSync owns them.
- You *can* still freely view, download, or inspect your synced Markdown notes and attachments in Google Drive Web/Mobile at any time.

---

## 2. Firebase Firestore (Spark Free Tier)

You can attach Firebase to the same Google Cloud project (or create a separate free Spark project) in [Firebase Console](https://console.firebase.google.com/).

1. Keep the project on the **Spark (Free)** plan — no billing card required.
2. **Enable Firestore Database**:
   - Go to **Build → Firestore Database → Create database**.
   - Start in **Production mode** and pick the region closest to you.
3. **Enable Authentication (Single Personal User)**:
   - Go to **Build → Authentication → Get started → Sign-in method**.
   - Enable **Email/Password**.
   - Go to **Authentication → Users → Add user** and create one personal email/password account for TriSync.
   - Copy that user's **User UID** (e.g. `AbC123XyZ...`).
   - **Disable public sign-up**: Go to **Authentication → Settings → User actions** and **uncheck "Enable create (sign-up)"** so nobody else can ever register an account on your Firebase project.
4. **Apply Firestore Security Rules (UID-Locked)**:
   - Go to **Firestore Database → Rules**, paste the following (replacing `YOUR_UID` with the exact User UID from Step 3), and click **Publish**:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sync_signals/{vaultId} {
      allow read, write: if request.auth != null
        && request.auth.uid == "YOUR_UID";
    }
  }
}
```

> Why `request.auth.uid` instead of email? Firebase normalizes `request.auth.token.email` to lowercase, so mixed-case email rules silently fail. Comparing `request.auth.uid == "YOUR_UID"` is exact, immutable, and immune to email casing issues.

5. **Get the Firebase Web Config**:
   - Go to **Project Settings (gear icon) → Your apps → Add app → Web (`</>`)**.
   - Register an app name (e.g. `TriSync`) and copy the JSON config object (`apiKey`, `authDomain`, `projectId`, `appId`, etc.).

---

## 3. Build & Install the Plugin

### 3.1 Build from Source (on MacBook)

```bash
cd obsidian-trisync
npm install
npm run build
```

This produces `main.js` alongside `manifest.json` and `styles.css`.

### 3.2 Install on macOS (MacBook)

1. Copy `main.js`, `manifest.json`, and `styles.css` into:
   ```text
   <YourVault>/.obsidian/plugins/obsidian-trisync/
   ```
2. In Obsidian: **Settings → Community plugins → Enable TriSync**.
3. Open **Settings → TriSync**:
   - Set **Device Name** to `MacBook` (each device automatically gets its own unique `deviceId`).
   - Set **Vault Name** (e.g. `MainVault`).
   - Paste Google **Client ID** and **Client Secret**, then click **Sign in with Google**.
     - Your browser opens to Google OAuth (`127.0.0.1:<port>/callback`, auto-closes after 120s).
     - Click **Advanced → Continue** and approve `drive.file`.
   - Paste your **Firebase Web Config JSON**, Firebase **Email**, and **Password**.
   - Click **Run Full Reconcile / Initial Sync**.
     - TriSync creates `My Drive/ObsidianSync/<VaultName>/` and stores its **`vaultRootFolderId`**, uploads your vault, and verifies Firestore signaling.

### 3.3 Install & Onboard on iPhone (iOS) and Android

1. Copy the same 3 files (`main.js`, `manifest.json`, `styles.css`) into `<YourMobileVault>/.obsidian/plugins/obsidian-trisync/`:
   - **iPhone (iOS)**: Use the **Files** app (`On My iPhone → Obsidian → <Vault> → .obsidian → plugins → obsidian-trisync/`, press `Cmd+Shift+.` or enable hidden files via Working Copy / Shellfish / a-Shell if needed) or AirDrop a zipped folder and unzip inside the plugin directory.
   - **Android**: Use your file manager (show hidden files) to copy the 3 files into `<Vault>/.obsidian/plugins/obsidian-trisync/`.
2. Enable **TriSync** in Obsidian mobile **Settings → Community plugins**.
3. **Transfer Credentials Securely via PIN-Encrypted Setup Bundle**:
   - On **MacBook**: Open **Settings → TriSync → Export Setup Bundle**, enter a one-time PIN (e.g. 6+ characters), and copy the `TRISYNC1:...` encrypted string.
     - The bundle is encrypted with **WebCrypto AES-256-GCM + PBKDF2** so raw OAuth/Firebase secrets are never exposed in iCloud Universal Clipboard or Android clipboard history.
     - It includes `vaultRootFolderId` (preventing duplicate root folders across devices) and **excludes `deviceId`** so each mobile device generates its own unique identity.
   - On **iPhone / Android**: Open **Settings → TriSync → Import Setup Bundle**, paste the `TRISYNC1:...` string, enter the same PIN, set **Device Name** (`iPhone` / `Android`), and tap **Sync Now**.

---

## 4. Troubleshooting

- **`invalid_grant` / Auth Circuit Breaker**: TriSync automatically pauses Drive requests if Google revokes or expires a refresh token. Re-authenticate on MacBook (confirm your OAuth app is **In Production**), then re-export the Setup Bundle to mobile devices.
- **iOS Background Resume**: Switching back to Obsidian on iPhone after >15s automatically cycles the Firestore network socket and runs an immediate `changes.list` delta sync.
- **Conflicts**: Overlapping edits or binary collisions never lose data — TriSync keeps the canonical file intact and writes `<Name> (conflict <Device> YYYY-MM-DD HHmmss).<ext>` (Android-safe filename with no colons). Open **TriSync: Show Activity & Conflicts** from the command palette to inspect and click directly into any conflict file.
