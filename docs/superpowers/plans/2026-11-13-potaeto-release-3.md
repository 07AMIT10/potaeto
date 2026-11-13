# Potaeto Release 3 — Make It Ubiquitous — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package Potaeto as a ubiquitous agent across Linux Desktop (Tauri v2) and Android, provide advanced offline storage with OPFS SAH-pool and multi-device conflict resolution UX, surface provider token/cost accounting, implement an automated restore drill, and document the complete multi-platform packaging pipeline within an idle RSS envelope of ≤ 150 MB.

**Architecture:**
- **Desktop (Tauri v2)**: Next.js static export (`out/`) bundled inside a lightweight native Tauri v2 wrapper (`src-tauri/`) with notification and opener plugins.
- **Mobile (Tauri v2 Android Target)**: Mobile project bindings in `src-tauri/gen/android` with microphone/audio permissions and resilient voice playback fallback.
- **Advanced Offline & Sync**: Modern `navigator.storage.persist()` and quota tracking, SQLite-WASM OPFS (`opfs-sahpool` without COOP/COEP isolation requirements) worker module with IndexedDB fallback, and an interactive multi-device conflict resolution UI for mutable rows.
- **Provider Usage Accounting**: Authenticated `GET /v1/models/usage` endpoint aggregating token usage and costs from `provider_usage`, with frontend model selector metrics.
- **Hardening & Verification**: Automated restore drill script (`scripts/restore.sh`), comprehensive packaging guide (`docs/PACKAGING.md`), and automated integration acceptance suite.

**Tech Stack:** Rust 1.80+ / Tauri v2 / Next.js 16.4.6 / React 19 / TypeScript / Tailwind CSS / SQLite 3.45+ / SQLite-WASM (`opfs-sahpool`) / Python 3.11+ / FastAPI / Uvicorn.

**Spec Reference:** `docs/superpowers/specs/2026-11-11-potaeto-sentient-agent-design.md` §7.12, §8, §9 (Release 3).

---

## Global Constraints

- **Strict Zero-PII Policy**: No real names, personal emails, personal hostnames, private IPs, or home paths exposing usernames. Use placeholders (`<user>`, `owner@example.com`, `example.com`, `192.0.2.10`, `agent-host`).
- **Resource Envelope**:
  - Tauri Desktop idle RSS: ≤ 150 MB.
  - PWA idle RSS: ≤ 100 MB.
  - Core server idle RSS: ≤ 250 MB (currently measured at ~51 MB).
- **Core / Client Boundary**: The Core orchestrator owns the canonical SQLite DB, hardware bridge, and agent loops; Tauri desktop and mobile are client shells connecting over HTTP/SSE.
- **Subagent Model**: Use `gemini-3.8-flash` (`flash`) for subagents.
- **Validation**: All tasks must verify both unit tests and `bash scripts/check-pii.sh`.

---

## File Structure

```
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/
    default.json
    mobile.json
  src/
    main.rs
    lib.rs
src/
  lib/
    native/
      platform.ts
      platform.test.ts
      notifications.ts
      notifications.test.ts
    storage/
      persistence.ts
      persistence.test.ts
      opfs-worker.ts
    voice/
      speech.ts
      speech.test.ts
  components/
    storage/
      StorageStatus.tsx
      StorageStatus.test.tsx
    sync/
      ConflictModal.tsx
      ConflictModal.test.tsx
      OutboxManager.tsx
      OutboxManager.test.tsx
apps/orchestrator/
  app/
    api/
      models.py                         # GET /v1/models/usage
  tests/
    test_models_usage.py
    test_backup_restore.py
    test_acceptance_release_3.py
scripts/
  restore.sh
  smoke-release-3.sh
docs/
  PACKAGING.md
```

---

## Tasks

### Phase 1: Tauri v2 Desktop & Notifications (Linux First)

- [ ] **Task 1: Tauri v2 Architecture Setup & Dependency Integration**
  - **Inputs:** `package.json`, Next.js static export (`out/`).
  - **Action:**
    1. Add Tauri v2 frontend dependencies: `@tauri-apps/api@^2.2.0`, `@tauri-apps/plugin-notification@^2.2.0`, `@tauri-apps/plugin-opener@^2.2.0` in `package.json`. Add `@tauri-apps/cli@^2.2.0` in `devDependencies`. Add `"tauri": "tauri"` script.
    2. Create `src-tauri/` project:
       - `Cargo.toml`: package `potaeto-desktop`, edition `2021`, dependencies `tauri`, `tauri-plugin-notification`, `tauri-plugin-opener`, `serde`, `serde_json`.
       - `src/lib.rs` and `src/main.rs`: initialize Tauri application with notification and opener plugins.
       - `tauri.conf.json`: configure `frontendDist: "../out"`, `productName: "Potaeto"`, `identifier: "com.potaeto.app"`, window size 1100x750, title "Potaeto".
       - `capabilities/default.json`: enable `core:default`, `notification:default`, `opener:default`.
    3. Run `npm install` and verify `cargo check --manifest-path src-tauri/Cargo.toml` succeeds.
  - **Outputs:** `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/capabilities/default.json`.
  - **Verification:** `cargo check --manifest-path src-tauri/Cargo.toml`, `npm run build`.

- [ ] **Task 2: Frontend Native Bridge & Unified Notifications**
  - **Inputs:** `src-tauri/capabilities/default.json`, `src/app/(app)/chat/[entityId]/ChatUI.tsx`.
  - **Action:**
    1. Implement `src/lib/native/platform.ts`:
       - `isTauri()`: checks `typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window`.
       - `getPlatform()`: returns `'desktop' | 'mobile' | 'web'`.
    2. Implement `src/lib/native/notifications.ts`:
       - Unified `sendNotification({ title, body, icon })` that dispatches to `@tauri-apps/plugin-notification` when in Tauri, standard browser `Notification` API when in Web/PWA, or logs cleanly when unsupported.
       - `requestNotificationPermission()`: requests permission via Tauri plugin or browser API.
    3. Wire notifications into `ChatUI.tsx` for tool approval alerts and background incoming agent messages.
    4. Write unit tests in `src/lib/native/platform.test.ts` and `src/lib/native/notifications.test.ts`.
  - **Outputs:** `src/lib/native/platform.ts`, `src/lib/native/notifications.ts`, test files.
  - **Verification:** `npx vitest run src/lib/native`, `npm run build`.

- [ ] **Task 3: Tauri Linux Desktop Build & Resource Verification**
  - **Inputs:** `src-tauri`, `out/`.
  - **Action:**
    1. Compile native Linux release binary using `npx tauri build --no-bundle` (or bundle `.deb`).
    2. Validate binary exists at `src-tauri/target/release/potaeto`.
    3. Measure binary size and verify idle RSS benchmark script against ≤ 150 MB ceiling.
  - **Outputs:** Native desktop executable `src-tauri/target/release/potaeto`.
  - **Verification:** Binary execution test, size check.

---

### Phase 2: Advanced Offline Storage & Multi-Device Conflict UX

- [ ] **Task 4: Storage Persistence & Quota Health Gauge**
  - **Inputs:** `src/lib/core/db.ts`.
  - **Action:**
    1. Implement `src/lib/storage/persistence.ts`:
       - `checkStoragePersistence()`: calls `navigator.storage.persisted()`.
       - `requestStoragePersistence()`: calls `navigator.storage.persist()`.
       - `getStorageQuota()`: calls `navigator.storage.estimate()` returning `{ usage, quota, percentUsed }`.
    2. Implement `src/components/storage/StorageStatus.tsx`:
       - Renders visual storage meter with percentage bar.
       - Shows badge: "Persistent Storage" (green) or "Best-effort Storage" (amber).
       - Provides "Request Persistent Storage" button.
    3. Embed `StorageStatus` in `/pair` and the app navigation shell.
    4. Write unit tests in `src/lib/storage/persistence.test.ts` and `src/components/storage/StorageStatus.test.tsx`.
  - **Outputs:** `src/lib/storage/persistence.ts`, `src/components/storage/StorageStatus.tsx`, tests.
  - **Verification:** `npx vitest run src/lib/storage src/components/storage`, `npm run build`.

- [ ] **Task 5: SQLite-WASM OPFS SAH-Pool Worker Module**
  - **Inputs:** `src/lib/core/db.ts`.
  - **Action:**
    1. Implement `src/lib/storage/opfs-worker.ts`:
       - Worker script loading `@sqlite.org/sqlite-wasm`.
       - Initializes VFS via `installOpfsSAHPoolVfs` (which works without cross-origin isolation headers).
       - Provides message-passing interface for query execution and transaction commit.
    2. Create `src/lib/storage/sqlite-client.ts`:
       - Connects to OPFS worker if supported; cleanly falls back to IndexedDB/Dexie.
    3. Write unit tests in `src/lib/storage/sqlite-client.test.ts`.
  - **Outputs:** `src/lib/storage/opfs-worker.ts`, `src/lib/storage/sqlite-client.ts`, tests.
  - **Verification:** `npx vitest run src/lib/storage`.

- [ ] **Task 6: Multi-Device Conflict Resolution UX & Outbox Manager**
  - **Inputs:** `src/lib/core/sync.ts`, `src/lib/core/types.ts`.
  - **Action:**
    1. Update `src/lib/core/sync.ts` to surface conflicts (`PushResult.status === 'conflict'`) into a dedicated `conflicts` reactive store/callback instead of dropping them silently.
    2. Implement `src/components/sync/ConflictModal.tsx`:
       - Detects conflicting entity revisions (`stale_rev`).
       - Presents side-by-side diff: Local Edited Version vs Server Canonical Version.
       - Offers two explicit actions: "Keep My Version" (forces push with bumped rev) or "Accept Server Version" (discards outbox item and pulls server state).
    3. Implement `src/components/sync/OutboxManager.tsx`:
       - Shows pending, failed, and conflicting sync operations.
       - Provides "Retry All" and "Clear Stuck Items" controls.
    4. Mount conflict handler in `CoreProvider.tsx` and outbox panel in `/pair` or chat header.
    5. Write unit tests in `src/components/sync/ConflictModal.test.tsx` and `src/lib/core/sync.test.ts`.
  - **Outputs:** `src/components/sync/ConflictModal.tsx`, `src/components/sync/OutboxManager.tsx`, tests.
  - **Verification:** `npx vitest run src/components/sync src/lib/core/sync.test.ts`.

---

### Phase 3: Android Architecture & Mobile Voice Integration

- [ ] **Task 7: Tauri Android Target Setup & Configuration**
  - **Inputs:** `src-tauri/tauri.conf.json`, `~/Android/Sdk`.
  - **Action:**
    1. Add Rust Android target architectures: `aarch64-linux-android`, `x86_64-linux-android`.
    2. Run Tauri Android initialization (`tauri android init`) or generate the Android Gradle structure in `src-tauri/gen/android`.
    3. Configure `AndroidManifest.xml` with permissions:
       - `<uses-permission android:name="android.permission.INTERNET" />`
       - `<uses-permission android:name="android.permission.RECORD_AUDIO" />`
       - `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`
    4. Configure `src-tauri/capabilities/mobile.json` targeting Android.
  - **Outputs:** `src-tauri/gen/android/`, `src-tauri/capabilities/mobile.json`.
  - **Verification:** Cargo compilation check for mobile targets.

- [ ] **Task 8: Resilient Mobile Voice & Audio Pipeline**
  - **Inputs:** `src/components/VoiceInput.tsx`, `/v1/voice/synthesize`.
  - **Action:**
    1. Implement `src/lib/voice/speech.ts`:
       - Primary: tests Web Speech API (`window.speechSynthesis`).
       - Fallback: if Web Speech API fails, lacks voices, or is throttled by Android WebView, automatically fetches audio from Potaeto Core `/v1/voice/synthesize` and plays via HTML5 Web Audio.
    2. Integrate resilient speech playback into chat turns.
    3. Write unit tests in `src/lib/voice/speech.test.ts`.
  - **Outputs:** `src/lib/voice/speech.ts`, `src/lib/voice/speech.test.ts`.
  - **Verification:** `npx vitest run src/lib/voice`, `npm run build`.

---

### Phase 4: Provider Usage Accounting, Automated Backup Drill & Hardening

- [ ] **Task 9: Provider Usage API & Model Picker Metrics**
  - **Inputs:** `apps/orchestrator/app/db/repositories/usage.py`, `apps/orchestrator/app/api/models.py`.
  - **Action:**
    1. Implement `GET /v1/models/usage` endpoint in `app/api/models.py`:
       - Returns aggregated metrics: `total_tokens_in`, `total_tokens_out`, `total_cost`, and breakdown by provider/model.
       - Enforces user device authentication.
    2. Implement stale-while-error catalog fallback in `apps/orchestrator/app/catalog/cache.py` so downstream model fetching never returns 500 when upstream provider APIs flap.
    3. Update `src/components/ModelPicker.tsx` to display token and cost summary badges.
    4. Write Pytest tests in `apps/orchestrator/tests/test_models_usage.py` and Vitest tests in `src/components/ModelPicker.test.tsx`.
  - **Outputs:** `apps/orchestrator/app/api/models.py`, `src/components/ModelPicker.tsx`, tests.
  - **Verification:** `uv run pytest tests/test_models_usage.py`, `npx vitest run ModelPicker`.

- [ ] **Task 10: Automated Backup Drill & Restore Script**
  - **Inputs:** `scripts/backup.sh`, `apps/orchestrator/app/db/connection.py`.
  - **Action:**
    1. Implement `scripts/restore.sh`:
       - Decompresses target `.db.gz` backup.
       - Runs SQLite integrity check: `PRAGMA integrity_check` (must return `ok`).
       - Verifies foreign keys: `PRAGMA foreign_key_check`.
       - Verifies table schemas match latest migrations (including `approvals` and `serial_events`).
       - Atomically restores to destination with backup copy of pre-existing database.
    2. Write Pytest test `apps/orchestrator/tests/test_backup_restore.py` verifying full backup & restore loop.
  - **Outputs:** `scripts/restore.sh`, `apps/orchestrator/tests/test_backup_restore.py`.
  - **Verification:** `bash scripts/restore.sh --help`, `uv run pytest tests/test_backup_restore.py`.

- [ ] **Task 11: Release 3 Acceptance Suite, Packaging Documentation & Smoke Script**
  - **Inputs:** All Release 3 deliverables.
  - **Action:**
    1. Create `docs/PACKAGING.md`:
       - Complete build and distribution instructions for Linux Desktop (Tauri binary & `.deb`).
       - Complete build instructions for Android APK.
       - PWA offline installation guide.
       - Backup automation via user systemd timer.
    2. Implement `apps/orchestrator/tests/test_acceptance_release_3.py`:
       - Acceptance Scenario 1: Desktop / client notification handshake.
       - Acceptance Scenario 2: Multi-device sync conflict resolution and outbox reconciliation.
       - Acceptance Scenario 3: Provider usage calculation and catalog resilience.
       - Acceptance Scenario 4: Database backup and restore integrity drill.
    3. Implement `scripts/smoke-release-3.sh` running full test suites, static build, and PII scan.
    4. Run `bash scripts/check-pii.sh` to ensure zero-PII compliance across all 300+ files.
  - **Outputs:** `docs/PACKAGING.md`, `apps/orchestrator/tests/test_acceptance_release_3.py`, `scripts/smoke-release-3.sh`.
  - **Verification:** `bash scripts/smoke-release-3.sh`, `bash scripts/check-pii.sh`.
