# TriSync (`obsidian-trisync`)

Fast, tri-directional personal Obsidian vault sync across **macOS**, **iOS**, and **Android**, powered by **Google Drive API v3 (`drive.file` scope)** and **Firebase Firestore (Spark Free Tier)** real-time change signals.

## Features

- **100% Free Google Backend ($0/mo, no billing card):** Files live as normal browsable `.md` notes and attachments inside `My Drive/ObsidianSync/<VaultName>/`, accelerated by a single lightweight Firestore Spark real-time signal document.
- **Fast Sync (~1–2s active, <1s mobile resume):** Direct targeted file pulls via Firestore `onSnapshot` signals, with incremental Google Drive `changes.list` delta sync fallback.
- **Smart 3-Way Line Merge:** Auto-merges non-overlapping offline edits using local base snapshots (`bases/<driveId>.txt`), validates `.canvas` JSON merges, and writes Android-safe conflict copies (`YYYY-MM-DD HHmmss`) only when the same lines or binary files collide.
- **Mobile-First (`isDesktopOnly: false`):** Zero Node.js runtime dependencies on iOS/Android, PIN-encrypted WebCrypto (AES-256-GCM + PBKDF2) Setup Bundle for fast Mac → iPhone/Android onboarding.

## Install via BRAT (macOS, iOS & Android)

1. In Obsidian, go to **Settings → Community plugins → Browse**, install **BRAT**, and enable it.
2. Open **BRAT Settings → Add Beta plugin**.
3. Paste this repository URL:
   ```text
   https://github.com/RajashekarSudireddy/obsidian-trisync
   ```
4. Click **Add Plugin**, then enable **TriSync** in **Settings → Community plugins**.

## Configuration

Follow [SETUP.md](./SETUP.md) for the one-time Google Drive OAuth (`drive.file`, Production mode) and Firebase Firestore Spark setup, then use **Export / Import Setup Bundle** to onboard iPhone and Android in under a minute.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
