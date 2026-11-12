# Potaeto — Sentient Agent Design

**Date:** 2026-11-11
**Status:** Revised for approval
**Owner:** maintainer
**Repo:** `Anveshak`

**Revision notes (2026-11-11):** incorporated the architecture review — Next.js 16 baseline, server-authoritative sync protocol, memory governance and evaluations, hardened security, separate voice cgroup/resource accounting, Lens OS research harness, and a smaller first release. The architecture is unchanged at ~80–85%; the contracts are now precise enough to plan from.

---

## 1. Intent

Potaeto stops being only a character-creation/chat app and becomes the **face and persona of one always-on personal agent**.

The agent lives on the user's self-hosted Linux host (`agent-host`, `192.0.2.10`) and is reachable from:

- a Telegram bot (phone-first remote control),
- a local-first desktop app,
- an Android app,
- an installable PWA.

It can chat in character, speak and listen, research, monitor, run scheduled workflows, remember across sessions, and drive physical output through an **Arduino Nano 33 BLE Sense Rev2** (onboard RGB LED, sensors, USB serial telemetry).

"Sentient" is product language for **persistent persona + durable memory + autonomy + tool use**. It is not a claim of consciousness.

The system is **server-authoritative with offline-capable clients**: the host owns canonical state; clients cache, compose offline, and sync through a precise protocol. This is not peer-to-peer local-first.

## 2. Why now

The pieces already exist but are disconnected:

- **Potaeto** — Next.js UI, Supabase data layer, Python FastAPI orchestrator, Gemini/Groq/Cerebras/SambaNova/OpenRouter adapters, expression avatars, TTS endpoint.
- **Agent host `agent-host`** — 24/7 self-hosted server with systemd services, Cloudflare Tunnel, power watchdog, and measured thermal/RAM thresholds.
- **Arduino Nano 33 BLE Sense Rev2** — flashed and validated: sensors streaming JSON at 115200 baud, RGB LED verified, Python SSE viewer working.
- **Lens OS** — research harness (OpenAlex, arXiv, PubMed, UniProt), MCP server, Telegram remote cockpit, bounded workers, tool-calling loop, SQLite persistence, context-budget management.
- **`agent-memory`** — markdown/graph durable memory CLI with `search` / `recall` / `add` / `journal`.

This design unifies them into one agent instead of a pile of demos.

## 3. Goals

1. **One agent, one persona.** Potaeto is the face; the same memory, tools, and schedule are shared by Telegram, desktop, Android, and PWA.
2. **Server-authoritative, offline-capable.** The agent host owns canonical state. Clients read cached data and compose offline; sync is ordered, idempotent, and recoverable.
3. **Installable everywhere.** Tauri v2 desktop (Linux first), Tauri v2 Android, and a real installable PWA from the same static build.
4. **Model-agnostic.** OpenCode Go, OpenRouter, and existing providers, with live model discovery, per-model protocol routing, usage/allowance tracking, data-retention visibility, and a model picker.
5. **Voice in and out.** Local-first TTS (Piper) and STT (whisper.cpp / sherpa-onnx), with cloud and browser fallbacks, isolated so they cannot OOM the core.
6. **Real tool use.** Research via the Lens OS harness, memory, scheduling, monitoring, workflows, and Arduino control — with approvals for destructive actions.
7. **Durable, governed memory.** `agent-memory` markdown remains canonical; SQLite indexes it; memories carry provenance, confidence, validity, supersession, scope, sensitivity, and retraction.
8. **Small footprint.** Fit the host's measured envelope and run comfortably on an 8 GB machine and a phone.
9. **Safe by default.** Cloudflare Access + application auth, no default admin password, no unauthenticated orchestrator, no secrets in the client bundle, SSRF-safe fetching, isolated command execution.

## 4. Non-goals (v1)

- Multi-tenant SaaS. One user / household first.
- A native Kotlin/Swift rewrite. Tauri mobile + PWA cover Android.
- iOS support. Tauri mobile iOS is immature; revisit later.
- A visual workflow editor. v1 ships named JSON workflows and a jobs panel.
- Running a local LLM on the agent host. Local models are limited to STT/TTS; reasoning stays with API providers.
- Replacing `agent-memory` with a graph database. Markdown stays canonical.
- CRDTs. A clear server-authoritative protocol is simpler and sufficient.
- A 30 MB desktop binary promise. The WebView is the floor; budget 80–150 MB.

## 5. Anti-goals (failure modes)

- A chatbot that forgets everything and dies when the cloud is down.
- An always-on service that overheats the host, gets OOM-killed, or starves other local services.
- Separate agents per interface that do not share memory or persona.
- A desktop app that is merely a browser tab in a wrapper with no offline value.
- API keys in the client bundle, anon-readable user tables, or default admin credentials.
- Lock-in to one provider or one hosted sync service.
- Unbounded autonomy that spends money or runs destructive commands without approval.
- Memory poisoning: web content or tool output silently becoming a trusted personal fact.
- A sync design where a phone with a skewed clock can silently overwrite a desktop edit.

## 6. Constraints

### 6.1 Host

- **Agent host `agent-host`**: 4-core/8-thread CPU, 8 GB RAM, 512 GB SSD, AC power only, `192.0.2.10`.
- **Dev workstation `dev-host`**: `192.0.2.11`; runs the editor/desktop client and SSHes to `agent-host`.
- Existing measured envelope:
  - CPU temperature: safe `< 70 °C`; warning `72–85 °C`; critical `> 85 °C`.
  - Load average: normal `< 2.5`; backlog `> 4.0`.
  - Available RAM: keep `> 400 MB` free (OOM guard).
  - Disk: alert `> 85 %`.
- Existing services on the box must not be starved; the agent runs under systemd cgroup limits.

### 6.2 Network

- Residential broadband; Cloudflare Tunnel configured with `--protocol http2`.
- Telegram is the reliable remote channel; LAN + tunnel are optional for the apps.
- PWA install, service workers, OPFS, and sqlite-wasm require a secure context (`https://` or `localhost`). Phone install therefore needs the Cloudflare Tunnel hostname (or a trusted local CA); plain `http://192.0.2.10` will not work.
- **Cloudflare Access** protects the remote hostname; application-level device auth sits behind it. Tunnel alone is not authentication.
- Deployment access: passwordless SSH from `dev-host` to `agent-host` is already established; the Arduino is plugged into `agent-host`.

### 6.3 Hardware bridge

- **Arduino Nano 33 BLE Sense Rev2** (`ABX00069/ABX00070`, nRF52840), USB VID `0x2341`, PID `0x805a`, `/dev/ttyACM0` at `115200` baud.
- Onboard active-low RGB LED; sensors: BMI270, BMM150, HS3003, LPS22HB, APDS-9960, MP34DT06J.
- Physically attached to the agent host. USB serial is the v1 transport; BLE is a later option. Use a stable udev symlink (e.g. `/dev/potaeto-arduino`) rather than relying on the device number.

### 6.4 Stack / versions

- **Frontend:** Next.js **16.4.6** (current stable, Active LTS as of 2026-11-09), React 19, Tailwind, TypeScript, `output: 'export'`. Next.js 14 is unsupported and must not remain the production baseline.
- **Static-export limits:** no Server Actions, no request-dependent Route Handlers, no middleware/Proxy, no ISR, no dynamic routes without `generateStaticParams`, no default image optimizer. All runtime-dependent calls go to the Python core.
- **Core:** Python 3.11+ FastAPI (existing `apps/orchestrator` refactored).
- **Client shells:** Tauri v2 (desktop + Android), one static `out/`.
- **Database:** SQLite (WAL) on the server; SQLite/OPFS or rusqlite on clients.
- **Research:** Lens OS harness (`lens-grounding` + `lens-ai`) exposed via MCP.
- **Voice:** Piper (TTS), whisper.cpp / sherpa-onnx (STT), isolated in a voice worker.

## 7. Decisions

### 7.1 Product shape (user-approved)

- **One agent**, with Potaeto as its persona/face.
- **The agent host `agent-host` is the source of truth**; Telegram and the apps are clients.
- **"Go plan" = OpenCode Go.** OpenRouter has no "Go" plan (its plans are Free / Standard / Business / Enterprise).
- **One shared conversation** per (user, primary agent) across channels. `messages.channel` records provenance (`app`, `telegram`, `job`); Telegram and the apps read the same thread, summary, and proactive logic.
- **Scope default (pending user confirmation):** `entities` stays as a table so the character editor and a future roster are possible, but v1 seeds one primary agent row. Multi-entity marketplace, anonymous public-preview AI, guest AI, and the admin dashboard are out of v1; public share pages become read-only. Identity collapses to one user + N devices, avoiding unauthenticated paid inference and shrinking the port.

### 7.2 Architecture

```
Telegram ─┐
Desktop  ─┼── HTTPS/WS ── Cloudflare Access ── Caddy :8080 ── potaeto-core :8000
Android  ─┤                                                        │
PWA      ─┘                                                        ├── SQLite (WAL)
                                                                   ├── provider adapters
                                                                   ├── agent loop + tools + scheduler
                                                                   ├── agent-memory indexer
                                                                   ├── lens-research MCP client ── lens-mcp (Rust, stdio)
                                                                   ├── voice client ── potaeto-voice (separate cgroup)
                                                                   └── serial bridge ── Arduino Nano 33 BLE Sense Rev2
```

- **`potaeto-core`**: one Python 3.11+ FastAPI process (refactor of `apps/orchestrator`), not a fleet of services. It owns persistence, the agent loop, providers, tools, scheduler, Telegram, and the serial bridge. It binds `127.0.0.1:8000` (reusing the current orchestrator port so `ORCHESTRATOR_URL` stays stable).
- **`potaeto-voice`**: a separate systemd service/cgroup that owns Piper and whisper.cpp. It exposes a small local HTTP/Unix-socket API. Bounded concurrency: one voice task at a time. This prevents TTS+STT peak memory from killing the core.
- **`lens-mcp`**: a small Rust MCP sidecar built from the Lens OS `lens-ai`/`lens-grounding` crates. It exposes the research harness (`search_literature`, `fetch_source`, `verify_claim`) and optionally the existing graph tools. The core spawns it over stdio and registers its tools. It runs only when research tools are used; it is not an always-on model.
- **Clients**: Next.js static export (`out/`) bundled into Tauri v2 desktop/Android and served as a PWA. No Node server in production.
- **Caddy** on `127.0.0.1:8080` serves the static client and proxies `/v1/*` to the core; Cloudflare Tunnel + Access map a hostname when remote access is wanted.
- **systemd hardening**: `MemoryMax`, `CPUQuota`, `Nice`, `IOSchedulingClass`, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, restricted `ReadWritePaths`, explicit USB-device access for the serial bridge.

**My call:** keep the server core in Python for v1 (it already has the provider adapters and skills pipeline). The efficiency-critical client shell is Tauri/Rust; voice and research sidecars are native. Revisit a Rust core only if measured RSS/CPU exceeds the budgets in §7.12.

### 7.3 Data layer and sync

**SQLite is the source of truth** on the agent host. Pragmas:

- `journal_mode=WAL`
- `synchronous=FULL` for canonical memory and important message writes; `NORMAL` for telemetry/logs (documented trade-off: a power loss can roll back recent `NORMAL` transactions).
- `foreign_keys=ON`, `busy_timeout=5000`.

Supabase is retired for v1; a one-time export script preserves existing data. Keep a read-only Supabase dump until the migration is verified.

Core tables (sketch):

```
users(id, name, passphrase_hash, created_at)
devices(id, user_id, name, token_hash, last_seen, created_at)
entities(id, user_id, name, slug, characteristics_json, appearance_json,
         persona_json, skills_json, attributes_json, is_public,
         created_at, updated_at, rev, deleted)
conversations(id, user_id, entity_id, title, created_at, updated_at, rev, deleted)
messages(id ULID, seq INTEGER, conversation_id, user_id, role, content, channel,
         meta_json, created_at, updated_at, rev, deleted)
conversation_summaries(conversation_id PK, summary, last_message_id, updated_at)
memories(id, user_id, entity_id, kind, content, source, source_ref,
         confidence, sensitivity, scope, status, valid_from, valid_to,
         supersedes, user_confirmed, created_at, updated_at, rev, deleted)
memory_edges(from_id, to_id, kind)
sync_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_type, entity_id,
             operation, payload_json, server_created_at)
device_sync_state(device_id PK, last_ack_seq, last_seen)
client_operations(idempotency_key PK, device_id, operation, status,
                  result_json, created_at)
model_catalog(provider, model_id, payload_json, fetched_at, etag)
settings(key, value_json)
jobs(id, name, schedule, timezone, workflow_json, enabled, last_run, next_run,
     lease_owner, lease_until, attempt_count, misfire_policy, idempotency_key,
     created_at)
job_runs(id, job_id, status, started_at, finished_at, output, error)
tool_calls(id, message_id, name, arguments_json, result_json, status,
           started_at, finished_at, approval_id, error_code, retry_count)
approvals(id, tool_call_id, action_hash, requested_at, expires_at, approved_at,
          approved_by, decision)
audit_events(id, ts, actor, kind, subject, detail_json)
provider_usage(id, provider, model_id, task_type, tokens_in, tokens_out,
               cost, allowance_json, success, latency_ms, created_at)
serial_events(id, ts, kind, payload_json)
audio_cache(id, text_hash, voice, path, created_at)
```

- **One shared thread** per (user, primary agent) across channels, with `messages.channel` provenance.
- **Concurrency control:** a single-flight turn queue per conversation. If a second message arrives while a turn is running, it queues; the UI/Telegram shows "queued". Cancellation is explicit. Proactive/job messages are inserted only when the conversation is idle or queued as system events. This prevents two tool loops reading the same history and interleaving replies.
- **FTS5** external-content tables: `messages_fts`, `memories_fts` (BM25). Add insert/update/delete triggers and an initial rebuild migration; verify FTS5 is compiled into all three SQLite drivers (server, Tauri, WASM).
- **Vector search:** v1 uses FTS5 + optional brute-force cosine over stored embeddings (start smaller than 100k; benchmark before choosing a threshold). `sqlite-vec` is pre-v1; it can be compiled into a custom SQLite WASM build but is not a drop-in loadable extension for every stock WASM build. Add later.
- **`agent-memory`**: markdown files under `~/agent-memory` remain canonical. An indexer walks the tree, hashes content, and upserts changed nodes into `memories` + `memories_fts`. Writes go through the CLI (`add`, `journal`); reads use `search`/`recall` or the index.
- **Backups:** use SQLite's online backup (`sqlite3 .backup` / `VACUUM INTO`), not a raw file copy of a live WAL database. Test restore. Back up `agent-memory` via git.

#### Sync protocol (server-authoritative)

The server assigns a monotonically increasing `seq` to every change. Clients pull after a cursor and acknowledge what they have applied.

```
GET  /v1/sync?after_seq=1234&limit=500
     -> { changes: [...], next_seq: 1280, has_more: false }

POST /v1/sync/ack
     { device_id, seq }
     -> { ok: true }

POST /v1/sync/push
     { device_id, operations: [
         { idempotency_key, entity_type, entity_id, base_rev, payload }
     ]}
     -> { results: [{ idempotency_key, status, rev?, seq?, error? }] }
```

Rules:

- Every client write carries an **idempotency key**; retries return the stored result and never duplicate messages.
- Mutable rows carry a server-assigned `rev`; a write with a stale `base_rev` returns `409` with the current row; the client rebases or prompts.
- Messages are append-only; the server assigns `seq` for ordering. ULIDs are IDs, not the ordering mechanism.
- Tombstones (`deleted=1`) are retained until all devices acknowledge them or a 30-day expiry applies.
- No CRDTs. This is deliberately server-authoritative.

### 7.4 Offline-capable clients

- **Build:** `next.config.mjs` → `output: 'export'`, `images.unoptimized: true`. CI verifies `out/` exists and that no unsupported server feature crept in.
- **Upgrade:** Next.js 16.4.6 + React 19 compatibility audit (async params, metadata, image loader, lint). This is a phase-0 requirement, not a nice-to-have.
- **Drivers** (one schema, three implementations):
  - Tauri desktop/Android: `rusqlite` (or `tauri-plugin-sql`) with bundled SQLite (FTS5 on).
  - PWA: `@sqlite.org/sqlite-wasm` + OPFS in a dedicated worker (`opfs-sahpool` to avoid COOP/COEP). This VFS is single-connection and worker-only; do not assume multiple tabs can open the same DB. Use another VFS if concurrency becomes necessary.
  - Dev/SSR: in-memory driver.
- **Storage durability:** call `navigator.storage.persist()`, show whether it was granted, and recover gracefully if the browser evicts storage. Server backup/sync is fundamental, not optional.
- **Offline behaviour:** cached conversations/entities render; new messages go to an outbox; sync on reconnect; conflict UI only for mutable entities.
- **PWA:** `public/manifest.webmanifest`, real 192/512 icons, Serwist service worker, `/offline` fallback, versioned cache with `skipWaiting`.
- **Tauri:** `src-tauri/` with SQL, opener, notification; **no client serial plugin** — the core owns serial. Define separate capabilities for desktop and Android; grant each plugin only what it needs; set an explicit CSP.
- **Auth:**
  - Tauri: device token in the OS keychain/secure storage.
  - PWA: do **not** put long-lived bearer tokens in `localStorage`. Use secure, `HttpOnly`, `SameSite` cookies with CSRF protection, or a carefully designed WebCrypto device credential.
  - WebSockets: authenticated handshake with a short-lived connection ticket; never a long-lived token in the query string.
  - Pairing: the server prints a short-lived code (or sends it via Telegram); the client exchanges it for a device credential. `users.passphrase_hash` is an optional admin/recovery passphrase, separate from device tokens.

### 7.5 Providers and model catalog

**Provider interface:** `list_models()`, `chat(request) → stream`, `supports_tools`, `protocol`, `normalize_usage`, `retention_policy`.

**OpenCode Go**

- Discovery: `GET https://opencode.ai/inference/go/v1/models` — **no auth**. Fallback chain: anonymous retry on 401/403 → `GET https://opencode.ai/inference/v1/models` → `GET https://models.dev/api.json` (`providers["opencode-go"]`) → bundled snapshot. Treat `models.dev` as **metadata fallback only**, never as authoritative Go-plan state; always trust the live list.
- Inference base: `https://opencode.ai/inference/go`.
  - Chat Completions: `POST /openai/v1/chat/completions`.
  - Native protocols (when the catalog's `api` map says so): `/openai/v1/responses`, `/anthropic/v1/messages`, `/google/v1beta/models/{model}:generateContent`.
- Auth: `Authorization: Bearer oc_sk_...` **plus** required `x-opencode-session: ses_<32 hex>` (derive deterministically from the conversation ULID; keep stable for cache locality).
- Use the catalog's `api` array per model; on `400 ModelProtocolUnsupported`, fall back to the native protocol. Never hardcode protocol routing.
- **Live contract:** model lineup, protocols, tool support, and allowances change. Add contract tests per protocol actually used.
- **Usage/allowances:** OpenCode returns per-model allowance information; store it in `provider_usage` and surface it in the provider health/budget layer.
- **Data retention:** OpenCode distinguishes zero-day-retention models from 30-day-retention models. Store the retention class in the catalog and show it in the model picker.
- Env: `OPENCODE_API_KEY` (alias `OPENCODE_GO_API_KEY`); optional `OPENCODE_BASE_URL`.
- Plans: Go $10/mo, Go Plus $40/mo, Teams $20/member/mo.
- **Do not make Go the sole foundation.** Verify the personal-chat/research workload with the provider; OpenCode Go is designed around coding-agent traffic. Keep at least one fallback provider configured.

**OpenRouter**

- `GET https://openrouter.ai/api/v1/models` — public, ~840 KB. Cache 24 h with ETag; project to ~50 KB (`id`, `name`, `context_length`, `pricing`, `supported_parameters`, `architecture`, `top_provider`).
- `POST https://openrouter.ai/api/v1/chat/completions`; `Authorization: Bearer $OPENROUTER_API_KEY`; optional `HTTP-Referer`, `X-OpenRouter-Title`.
- Streaming: tolerate comments and fragmented events; skip `: OPENROUTER PROCESSING`; the usage chunk repeats `finish_reason` before `[DONE]`; mid-stream failures arrive as HTTP 200 with an `error` field and `finish_reason:"error"`.
- **No "Go" plan.** Plans: Free / Standard / Business / Enterprise.
- OpenRouter validates `tools` on **every** request, including tool-result turns. Check `supported_parameters` and test actual tool calls; do not trust model names.

**Existing providers** (Gemini, Groq, Cerebras, SambaNova, HuggingFace) stay behind the same interface. Gemini remains for image generation; text routing prefers OpenCode Go/OpenRouter when configured.

**Model picker UI**: provider, model, context length, max output, tool support, approximate cost, availability/health, allowance, and data-retention class. Never expose keys.

**Caching**: Go list 5 min TTL; OpenRouter 24 h; persist in `model_catalog`; serve stale on network failure; ETag/conditional fetch.

### 7.6 Tool calling

- Canonical OpenAI wire shape:

```json
{"tools":[{"type":"function","function":{"name":"…","description":"…","parameters":{…}}}],
 "tool_choice":"auto","parallel_tool_calls":true}
```

- Model returns `message.tool_calls[]`; reply with `role:"tool"`, `tool_call_id`, `content`.
- Streaming:
  - Generic SSE parser: comments, fragmented events, unknown fields.
  - Accumulate tool deltas by `index`; tolerate missing `index` after the first chunk.
  - **Do not execute a tool until the complete arguments have been received and JSON-parsed.**
  - Detect error objects and error finish reasons; recover from mid-stream provider failure.
  - Distinguish provider errors, tool errors, and model answers in the UI and logs.
- Tool registry with `read_only` / `mutating` / `requires_approval` flags.
- **MCP is client-side.** v1 uses the Lens OS `lens-mcp` sidecar over stdio, plus built-in tools. Add other MCP servers later by converting descriptors into OpenAI `tools`.
- Max 8 tool turns per user message; each result capped (default 8 KB); unknown tool → structured error back to the model.

### 7.7 Agent loop, memory, and autonomy

**Loop:** system prompt (persona + safety + tool instructions) → context budget → model → tool calls → tool results → repeat → final answer → persist + summarize.

**Context budget (model-aware, dynamic):**

- Derive the budget from the selected model's catalog `context_length`:
  `max(POTAETO_CONTEXT_FLOOR, min(context_length - POTAETO_MAX_OUTPUT_TOKENS - 1024, POTAETO_CONTEXT_CEILING))`.
  Defaults: floor 4,000, ceiling 32,000, max output 4,096; unknown models fall back to 8,000. The live deployment sets the ceiling to 64,000.
- Pinned: persona, 3–5 stable facts, current time/place.
- Recency: last 10–30 messages, scaled to the budget.
- Retrieval: top 8–16 memory nodes via hybrid FTS5 + optional vector RRF (k=60).
- Summary rollup when >75% of budget; token estimate `chars/4`; nodes capped at ~400 tokens with an `…expand <id>` marker. Cap the **whole** assembled prompt (prefix + summary + history + user), not just history.

#### Memory governance

Memory is not a text dump. Every memory carries:

| Field | Purpose |
|---|---|
| `source`, `source_ref` | Where it came from (user, conversation, web, tool, document) |
| `confidence` | Confirmed fact vs. inference |
| `valid_from`, `valid_to` | Temporal validity |
| `supersedes` | Which older memory it replaces |
| `scope` | Global / project / conversation |
| `sensitivity` | Whether it should be restricted |
| `status` | `active` / `superseded` / `retracted` |
| `user_confirmed` | True only when the user explicitly confirmed it |

Operations: `memory_search`, `memory_recall`, `memory_add`, `memory_update`, `memory_supersede`, `memory_retract`, `memory_journal`.

Rules:

- Retrieval returns **active** memories only; superseded/retracted memories are excluded.
- The user can retract a memory; it disappears from retrieval and downstream prompts. Markdown keeps the audit history, but retracted facts are never presented as valid.
- Web/tool-derived facts are **candidates** with provenance, not confirmed personal facts. Do not silently promote them.
- The agent cites memory IDs when it uses a remembered fact.
- Memory poisoning is a security concern: tool permissions are enforced in application code, not by the model's interpretation of a system prompt.

**Memory evaluations** (must pass before calling memory complete):

1. Recall a fact after a server restart.
2. Recall information from several separate sessions.
3. Update an old fact; verify the new fact wins.
4. Ask about a fact that is no longer valid; verify the agent does not present it as current.
5. Revoke a stored fact; verify it no longer influences answers.
6. Ask the agent to perform an action using a remembered preference.
7. Verify private/project-specific memories do not leak into unrelated contexts.

**Tools (v1):**

| Tool | Purpose | Safety |
|---|---|---|
| `lens_research` | Literature search via Lens OS (OpenAlex/arXiv/PubMed) | read-only |
| `lens_fetch` | Fetch/parse a paper/URL via Lens OS (`fetch_source`) | read-only, SSRF-safe |
| `memory_*` | Search/recall/add/update/supersede/retract/journal | governed writes |
| `scheduler` | Create/list/cancel jobs | mutating, confirm in app |
| `monitor` | HTTP ping, disk, RAM, CPU temp, service status | read-only |
| `arduino_led` | Set colour/pattern | low-risk |
| `arduino_read` | Read sensors | read-only |
| `run_command` | Shell in an isolated workspace | **requires approval**, sandboxed |
| `workflow_run` | Run a named workflow | depends on steps |

**Scheduler:** a simple DB-backed scheduler with atomic leases (`jobs.lease_owner`, `jobs.lease_until`), not APScheduler v4 (prerelease). Explicit timezone, retries, overlap policy, misfire policy, and idempotency key. One instance for v1; leases prevent duplicate execution.

**Workflows:** JSON step lists (`tool`, `llm`, `condition`, `notify`, `memory_add`) stored in `jobs.workflow_json`; no visual editor. Concurrency capped at 2–3 workers on the agent host; hard timeouts; heartbeats; cancel on shutdown. Destructive steps require approval.

**Autonomy:** built-in jobs (morning briefing, periodic monitor check, research task, idle proactive message, LED status). Proactive messages are inserted only when the conversation is idle or queued as system events.

**Approvals:** `approvals` table stores the exact action hash, expiry, decision, and approver. Approval is bound to the exact command/arguments; it expires and is not reusable for a different action. Telegram inline buttons and the app modal both write to the same table.

**Audit:** `audit_events` records security-relevant actions, tool calls, approvals, and job runs. This answers: what did it do, who initiated it, was it approved, did it fail halfway, did a retry execute twice, how much did it cost, which memory/context influenced it.

### 7.8 Voice

- **`potaeto-voice` is a separate systemd service/cgroup.** It owns Piper (TTS) and whisper.cpp / sherpa-onnx (STT). One task at a time by default; bounded queue.
- **TTS:** Piper `medium` voice, spawned per sentence, 64–114 MB model file. Benchmark the **process RSS** (a recent benchmark reports ~503 MB for a Piper Python process), not just the model file. Cache audio by `(text_hash, voice)`. Fallbacks: Gemini/OpenAI cloud TTS when online; Android system `TextToSpeech` on-device.
- **STT:** whisper.cpp `base.en` on the agent host for uploaded voice notes (~388 MB peak); sherpa-onnx streaming Zipformer for low-latency/Android later. Browser fallback: Web Speech API when online; transformers.js `whisper-tiny.en` on WebGPU as a last resort.
- **Do not rely on `speechSynthesis` inside Tauri Android WebView** (reported missing); test on a real device.
- **Do not claim 7× real-time whisper** as a property of the reference host; benchmark under sustained CPU load.
- v1 is push-to-talk + voice notes; streaming partials are v2.

### 7.9 Telegram

- Long polling (no public webhook needed); raw Bot API or a light client.
- Fail-closed allowlist: `TELEGRAM_ALLOWED_CHAT_IDS`.
- Persist update IDs; acknowledge only after durable processing; dedupe retries.
- Free text routes to the agent; commands: `/start`, `/status`, `/model`, `/jobs`, `/memory`, `/led`, `/approve`, `/pause`, `/resume`.
- Streaming typing indicator; `sendMessageDraft` for transient previews in private chats; 4096-char splitting; inline keyboards for approvals.
- Voice notes: download → STT → agent; replies can be text + TTS voice note.
- Rate-limit and backoff; never log the bot token.

### 7.10 Arduino bridge

- Runs inside the core on the agent host; auto-detects the stable udev symlink (`/dev/potaeto-arduino`), reconnects, buffers, and degrades to "unavailable" if the board is absent (never crashes the agent).
- JSON-lines protocol with command IDs, acknowledgements, and a protocol version:

```json
{"id":"c1","v":1,"cmd":"led","r":255,"g":0,"b":0,"pattern":"breathe"}
{"id":"c1","ok":true}
{"evt":"telemetry","acc":[…],"temp":…,"hum":…,"light":…}
```

- Commands: `led` (colour/pattern), `read`, `ping`, `reset`. Ack every command; time out and retry.
- Firmware source: extend the existing firmware sketch in `~/projects/arduino-firmware` (not this repo) to implement the command protocol. The bridge must tolerate telemetry-only firmware until that flash lands.
- **Bounded telemetry retention:** keep detailed `serial_events` for a short window (e.g. 7 days), then aggregates; never store every reading indefinitely.
- Tools: `arduino_led`, `arduino_read`, `arduino_pattern`.
- UI: colour picker, pattern presets, live sensor charts (reuse the firmware project's SSE viewer ideas).
- Clients never open serial directly; the core owns the device.

### 7.11 Security

- **Remote access:** Cloudflare Access in front of the remote hostname **and** application-level device auth behind it. Tunnel is routing, not authentication.
- Core binds `127.0.0.1:8000`; Caddy `:8080`; Cloudflare Tunnel only when needed.
- **Auth on every core endpoint** (device token or HMAC). No unauthenticated orchestrator.
- **No default admin credentials.** If `ADMIN_SECRET` is unset, admin routes return `503`.
- **PWA auth:** no long-lived bearer tokens in `localStorage`; use `HttpOnly`/`SameSite` cookies with CSRF or a WebCrypto device credential. WebSockets use a short-lived ticket, not a token in the query string.
- **`run_command` isolation:** run under a separate restricted identity/execution service with a restricted workspace, no access to provider keys or the main DB, no unrestricted home access, explicit network restrictions, and CPU/memory/process/time limits. Approval is bound to the exact command and arguments, expires, and is not reusable.
- **`web_fetch`/`lens_fetch` SSRF protection:** block `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local, and cloud metadata endpoints; revalidate after redirects; protect against DNS rebinding; allow only `http`/`https`; size/time limits.
- **Memory poisoning:** retrieved documents are untrusted; never execute instructions from them; tool permissions are checked in code, not delegated to the model.
- **Tauri:** per-platform capabilities; least-privilege plugins; explicit CSP; no client serial plugin.
- **Secrets:** server-side only, encrypted at rest, `.env` mode `600`, never logged or shipped to the client.
- **Telegram:** allowlist, fail closed, token never logged, rate limits.
- **Audit:** `audit_events` for security-relevant actions; alert on repeated auth failures and unexpected tool approvals.
- **Backups:** encrypted SQLite online backups; restore test; `agent-memory` git.

### 7.12 Efficiency and resource budgets

- **Separate cgroups:**
  - `potaeto-core.service`: `MemoryMax=512M`, `CPUQuota=200%`, `Nice=5`.
  - `potaeto-voice.service`: `MemoryMax=1G`, `CPUQuota=300%`, `Nice=10` (Piper ~500 MB + whisper ~388 MB peak, one task at a time).
  - `lens-mcp` sidecar: `MemoryMax=256M`, on demand.
- **Budgets (enforced in CI/monitoring):**
  - Core RSS ≤ **250 MB** (target 150 MB), idle CPU ≤ **5 %**, startup ≤ **3 s**.
  - Voice worker idle RSS ≤ **80 MB**; peak measured on the agent host, not assumed.
  - Tauri idle ≤ **150 MB**; PWA ≤ **100 MB**.
  - Model catalog fetch ≤ 36 KB (Go); OpenRouter projected/cached.
  - Transcription only while a voice note is processed; TTS model unloaded when idle.
- **No Node server in production**; static client; one core process.
- Lazy-load catalogs, embeddings, and voice models; unload idle models after ~10 min.
- Streaming everywhere; no double-buffering; SQLite WAL + prepared statements.
- Client: virtualized lists, code splitting, no giant global stores.
- Monitor with the existing `server-health` CLI and alert at the thresholds in §6.1.
- Measure after each release; if the core exceeds 250 MB or idle CPU exceeds 5 %, profile before adding features.

## 8. Release plan

The first release proves the agent, not the packaging. Each release is shippable and measurable.

### Release 1 — Prove the agent

- One persona, one user, multiple device identities.
- Python FastAPI core + SQLite (schema, migrations, repositories).
- Device pairing + authenticated API + Cloudflare Access.
- PWA chat and conversation history (Next.js 16 static export).
- Durable memory with provenance, validity, supersession, retraction, and retrieval.
- One reliable provider + one fallback (OpenCode Go and/or OpenRouter).
- Telegram remote interface.
- Read-only monitor tools.
- Simple DB-backed scheduler with durable job state.
- Security baseline: no default admin, auth on every endpoint, SSRF-safe fetch, audit log.

### Release 2 — Give it capabilities

- Tool calling + approval system + audit lifecycle.
- Lens OS research harness (`lens-mcp`): `search_literature`, `fetch_source`, `verify_claim`.
- Workflows and proactive messages.
- Arduino LED control and sensor telemetry (firmware command protocol).
- Voice notes and local TTS (voice worker).
- Memory evaluations and governance UI (retract/supersede).

### Release 3 — Make it ubiquitous

- Tauri Linux desktop.
- Tauri Android.
- Android-specific voice integration.
- Native notifications or remote push (v1 uses Telegram for proactive; no FCM until proven necessary).
- Advanced offline functionality and sync polish.
- Additional provider and memory optimizations.
- Packaging, backup/restore, docs.

## 9. Acceptance criteria

### Release 1

> **Scope note (2026-11-12):** `run_command` approvals, workflow auto-answer,
> and the full summary rollup are **Release 2**. Release 1 acceptance covers the
> agent turn, durable memory, sync, the provider catalog/picker, Telegram,
> schedules, the monitor tools, and the security baseline. Retrieval may return
> recent memories when a query has no lexical match, but a full summary model
> call is not part of this release.

- Telegram: send a message from the phone, get an in-character streamed reply.
- PWA: install, chat offline from cache, send while offline, sync on reconnect; show persistent-storage status.
- Auth: unauthenticated request to the core is rejected; Cloudflare Access + device auth both enforced; no default admin login.
- Memory: tell it a fact; restart the server; ask later; it recalls the fact with a cited memory ID. Update, supersede, and retract tests pass.
- Sync: two devices edit the same entity offline; reconnect; no silent overwrite; retries do not duplicate messages.
- Provider: pick a model from the catalog; no key ever reaches the client; catalog shows context, tools, cost, allowance, and retention.
- Schedule: create a job; it fires once (lease prevents duplicates) and notifies Telegram.
- Efficiency: core RSS ≤ 250 MB idle, CPU ≤ 5 % idle, no thermal warnings over 24 h.
- Security: SSRF probes blocked; audit events recorded. (`run_command` approval is Release 2 per the scope note above.)

### Release 2

- Ask "research X and turn the LED green": Lens OS search + fetch + Arduino tools run; results are visible and audited.
- Memory evaluation suite passes (7 tests).
- Voice note → STT → agent → text + TTS reply; voice worker peak RSS measured within its cgroup.
- Workflow/proactive message fires at the right time, once.

### Release 3

- Desktop Tauri and Android APK install and chat; PWA installable outside the LAN.
- Idle/packaging budgets met; backup/restore verified.

## 10. Open questions

**User-only (answers change the plan):**

1. **Product scope:** is v1 one agent (Potaeto as the single persona, character editor retained for its persona) or a roster of characters where one is the always-on agent? The repo today ships character creation, multiple entities, public preview, guest mode, and an admin dashboard. *Default if unanswered: one agent; retire marketplace/public-preview AI/guest/admin from v1 and keep `entities` for later.*
2. **Live data:** is the current Supabase deployment live with real users/data, or only your own test data? *Default if unanswered: personal/test data; still export + keep a read-only dump.*
3. **Remote access:** should the phone PWA/Android app work outside the LAN (requires the Cloudflare Tunnel HTTPS hostname + Access), or is LAN + Telegram enough for v1? *Default if unanswered: tunnel hostname, because phone PWA install needs HTTPS.*
4. **Android test device:** which phone/OS version should be the target for the first APK? Can be answered before Release 3.

**Builder decisions (my calls, open to correction):**

- Python core for v1; Rust only for the Tauri shell, `lens-mcp`, and voice binaries.
- Tauri v2 over Electron/Capacitor; one static `out/` for desktop, Android, and PWA.
- Next.js 16.4.6 + React 19 upgrade in phase 0; keep `output: 'export'`.
- One shared conversation across channels with a per-conversation turn queue.
- Server-authoritative sync with `seq`, idempotency keys, revisions, tombstones, and acks; no CRDTs.
- FTS5 first; optional brute-force embeddings; `sqlite-vec` later.
- DB-backed scheduler with atomic leases; no APScheduler v4.
- Device-pairing auth; PWA uses `HttpOnly` cookies or WebCrypto, not `localStorage` tokens.
- Piper `medium` TTS + whisper.cpp `base.en` STT in a separate voice cgroup.
- **Research tool = Lens OS harness**, not Brave/Tavily/SearXNG. Add a `lens-mcp` sidecar to the research-harness repo; keep a general web-search fallback optional.
- Arduino firmware extended in `~/projects/arduino-firmware`; bridge degrades if absent.
- Telegram is the reliable proactive channel for v1; no FCM until proven necessary.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Thermal throttling / OOM on the agent host | separate cgroups, 1 core process, lazy models, `server-health` alerts, load ceilings, voice worker isolation |
| Tauri Android WebView gaps (speech, serial) | server-side TTS/STT/serial; test on real hardware early |
| SQLite WASM/OPFS browser limits (Safari eviction, single connection) | worker-only `opfs-sahpool`, `navigator.storage.persist()`, server backup, IndexedDB fallback, storage-status UI |
| Sync correctness (clock skew, retries, concurrent edits) | server `seq`, idempotency keys, `base_rev` checks, tombstones, per-conversation turn queue |
| Memory poisoning / stale facts | provenance, validity, supersession, retraction, candidate-only web facts, evals |
| SSRF / LAN exposure via fetch tools | destination validation, redirect revalidation, DNS-rebinding protection, scheme/size/time limits |
| Provider catalog churn (OpenCode models/protocols) | fetch `api` map on every refresh; contract tests; bundled snapshot; stale-while-error; fallback provider |
| OpenCode Go workload suitability | verify with provider; keep OpenRouter/other fallback; do not make Go the sole foundation |
| Tool abuse / runaway autonomy | approvals bound to exact action, allowlists, turn/token/time caps, audit log |
| Secret leakage | server-only keys, encrypted at rest, no client bundle secrets, secret scanning |
| Migration data loss from Supabase | export script + row counts + checksum; keep a read-only Supabase dump until verified |
| Voice memory spikes | separate cgroup, one task at a time, benchmark process RSS, unload idle models |

---

## Appendix A — Provider quick reference

| Provider | Models | Inference | Auth | Notes |
|---|---|---|---|---|
| OpenCode Go | `GET https://opencode.ai/inference/go/v1/models` (no auth) | `https://opencode.ai/inference/go/openai/v1/chat/completions` | `Bearer oc_sk_…` + `x-opencode-session` | use per-model `api` map; record allowance + retention; plans Go/Go Plus/Teams |
| OpenRouter | `GET https://openrouter.ai/api/v1/models` (public) | `https://openrouter.ai/api/v1/chat/completions` | `Bearer $OPENROUTER_API_KEY` | no "Go" plan; tools on every request; robust SSE errors |
| OpenCode public catalog | `GET https://models.dev/api.json` | — | none | metadata fallback only, `providers["opencode-go"]` |
| Gemini | Google API | `generateContent` / TTS / image | API key | keep for image + fallback TTS |
| Lens OS research | `lens-mcp` stdio (local) | `search_literature`, `fetch_source`, `verify_claim` | local only | reuses `lens-grounding` (OpenAlex, arXiv, PubMed, UniProt) |

## Appendix B — Hardware quick reference

| Item | Value |
|---|---|
| Board | Arduino Nano 33 BLE Sense Rev2 (`ABX00069/ABX00070`, nRF52840) |
| USB | stable udev symlink (e.g. `/dev/potaeto-arduino`), 115200 baud, JSON lines |
| LED | active-low RGB (`LEDR`, `LEDG`, `LEDB`) |
| Sensors | BMI270, BMM150, HS3003, LPS22HB, APDS-9960, MP34DT06J |
| Flash | `arduino-cli` + `bossac` 1.9.1, `arduino:mbed_nano@4.6.0` |
| Firmware | extend the existing sketch in `~/projects/arduino-firmware`; command IDs, acks, protocol version |
| Viewer prior art | firmware project's `viewer/server.py` SSE + canvas dashboard |

## Appendix C — Lens OS research harness integration

- **Source:** a separate research-harness repository (Rust workspace; not this repo).
- **Existing pieces:** `lens-grounding` (`openalex.rs`, `arxiv.rs`, `pubmed.rs`, `uniprot.rs`), `lens-ai` (`tools/research.rs`: `search_literature`, `fetch_source`, `verify_claim`), `lens-ai` MCP server (`mcp/server.rs`, 11 graph tools over JSON-RPC stdio).
- **New sidecar:** add a `lens-mcp` binary in `lens-ai` (or a sibling crate) that opens the Lens DB (optional) and runs the MCP server over stdio. Add research tools to `tools/list` and `tools/call`; they use `lens-grounding` and do not require the graph DB.
- **Potaeto integration:** the Python core spawns `lens-mcp` on demand, registers its tools, and calls them through the standard tool loop. If the sidecar or DB is unavailable, research tools return a structured error; the agent falls back to a plain URL fetch.
- **Why this shape:** reuses tested Rust code, keeps memory low (~5–15 MB sidecar), avoids a second search API dependency, and lets Potaeto use the same research harness as Lens OS.
- **Repo boundary:** changes to that repository require explicit user confirmation there (per its `AGENTS.md`).
