# Potaeto Multi-Platform Packaging Guide (Release 3)

This document provides instructions for building, packaging, and deploying Potaeto across its supported client targets: **Linux Desktop (Tauri v2)**, **Android (Tauri v2 APK)**, and **Progressive Web App (PWA)**, alongside backend maintenance and backup automation.

---

## 1. Prerequisites

- **System**: Linux x86_64 or aarch64
- **Node.js**: v20+ / v24+ with npm
- **Rust Toolchain**: Rust 1.80+ (`cargo`, `rustc`)
- **System Libraries (Linux Desktop)**:
  ```bash
  sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Android Toolchain (Android APK)**:
  - Java 17+ (`JAVA_HOME`)
  - Android SDK Platform 34+ (`ANDROID_HOME`)
  - Android NDK 27+ or 28+ (`NDK_HOME`)
  - Rust Android targets:
    ```bash
    rustup target add aarch64-linux-android x86_64-linux-android
    ```

---

## 2. Linux Desktop Build (Tauri v2)

Potaeto packages the pre-built Next.js static export (`out/`) inside a native Tauri v2 wrapper.

### Build Steps:

1. **Build the Next.js static frontend**:
   ```bash
   npm run build
   # Generates out/ directory with 11 prerendered routes
   ```

2. **Compile the native desktop binary**:
   ```bash
   # Standalone release binary
   cargo build --release --manifest-path src-tauri/Cargo.toml
   # Binary generated at: src-tauri/target/release/potaeto-desktop (~17 MB)
   ```

3. **Package as Debian package (`.deb`) / AppImage**:
   ```bash
   npx tauri build
   # Bundles are placed in: src-tauri/target/release/bundle/
   ```

### Runtime Architecture:
- Window size: 1100x750 (minimum 600x400).
- Memory footprint: ≤ 120 MB idle RSS.
- Native plugins:
  - `@tauri-apps/plugin-notification`: Dispatches native desktop notifications for tool approvals and background messages.
  - `@tauri-apps/plugin-opener`: Safe sandbox opening of documentation and external URLs.

---

## 3. Android Mobile Build (Tauri v2)

The Android target embeds the same PWA inside an Android System WebView with native audio and notification permissions.

### Build Steps:

1. **Set Environment Variables**:
   ```bash
   export JAVA_HOME="/path/to/jdk-17"
   export ANDROID_HOME="/path/to/Android/Sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
   export PATH="$JAVA_HOME/bin:$PATH"
   ```

2. **Generate / Sync Android Project**:
   ```bash
   npx tauri android init --ci --skip-targets-install
   ```

3. **Build Android APK (Release)**:
   ```bash
   npx tauri android build --apk
   # Output APK placed in: src-tauri/gen/android/app/build/outputs/apk/release/
   ```

### Manifest & Audio Permissions:
- Permissions enabled in `AndroidManifest.xml`:
  - `android.permission.INTERNET` (API connection to agent core)
  - `android.permission.RECORD_AUDIO` (voice input)
  - `android.permission.POST_NOTIFICATIONS` (background agent alerts)
- Resilient audio synthesis:
  - Primary: `window.speechSynthesis` (foreground native speech).
  - Fallback: `/v1/voice/synthesize` streaming 16 kHz WAV audio.

---

## 4. Progressive Web App (PWA) Distribution

For mobile devices and desktop browsers without native installation:

1. **Serve Static Export with Caddy**:
   ```caddy
   :8080 {
       handle /v1/* {
           reverse_proxy 127.0.0.1:8010
       }
       handle {
           root * /opt/potaeto/out
           try_files {path} {path}.html {path}/index.html /index.html
           file_server
       }
   }
   ```
2. **Offline & Storage Guarantees**:
   - Service worker (`public/sw.js`) caches shell assets and static routes.
   - Storage persistence API (`navigator.storage.persist()`) protects offline databases from browser eviction.
   - SQLite-WASM OPFS SAH-pool (`src/lib/storage/opfs-worker.ts`) provides high-performance storage without COOP/COEP isolation headers.
   - Dexie / IndexedDB fallback ensures compatibility across older browser engines.

---

## 5. Automated Backup & Restore Automation

Database backups are created using SQLite's online backup API to prevent WAL corruption:

### Creating a Backup:
```bash
scripts/backup.sh --db /opt/potaeto/data/potaeto.db --dest ~/potaeto-backups
```
- Daily backups: newest 7 retained.
- Weekly backups: newest 4 retained.
- Umask `077` enforced (mode 600 private permissions).

### Restoring from Backup (with Validation):
```bash
# Dry-run validation (checks gzip, integrity_check, foreign keys, and schemas without modifying files)
scripts/restore.sh --backup ~/potaeto-backups/daily/potaeto-20261113.db.gz --dry-run

# Live restore (atomically saves current DB to .bak and restores)
scripts/restore.sh --backup ~/potaeto-backups/daily/potaeto-20261113.db.gz --dest /opt/potaeto/data/potaeto.db
```

---

## 6. Resource Envelope Benchmarks

| Component | Target Envelope | Measured Idle | Peak Measured |
| :--- | :--- | :--- | :--- |
| **`potaeto-core`** | ≤ 250 MB | **51.0 MB** | 54.2 MB |
| **`potaeto-caddy`** | ≤ 50 MB | **11.5 MB** | 13.3 MB |
| **`potaeto-voice`** | ≤ 100 MB | **33.8 MB** | 34.2 MB |
| **Tauri Desktop** | ≤ 150 MB | **~85 MB** | 115 MB |
| **PWA Web App** | ≤ 100 MB | **~42 MB** | 68 MB |
