# Potaeto Release 1 — Prove the Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-user, single-persona agent on a self-hosted Linux host with SQLite persistence, device auth, server-authoritative sync, PWA chat, one provider + fallback, durable memory, Telegram control, read-only monitor tools, and a durable scheduler.

**Architecture:** A FastAPI core (`apps/orchestrator`, service name `potaeto-core`) owns SQLite, auth, sync, the agent loop, memory, providers, Telegram, and the scheduler. The Next.js 16 static PWA is a thin client with an IndexedDB cache/outbox. One shared conversation per user/agent. No Tauri, voice, Arduino, workflows, or Lens OS research in this release.

**Tech Stack:** Python 3.11+ / FastAPI / stdlib `sqlite3` / pytest; Next.js 16.4.6 / React 19 / TypeScript / Dexie / Serwist / Vitest; Caddy; systemd; Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-11-11-potaeto-sentient-agent-design.md`

---

## Global Constraints

- Next.js **16.4.6** + React **19**, `output: 'export'`, `images.unoptimized: true`. Next 14 must not remain.
- Python **3.11+**; core binds `127.0.0.1:8000`; Caddy serves `:8080`.
- SQLite: `journal_mode=WAL`, `synchronous=FULL` for canonical writes (`NORMAL` only for telemetry), `foreign_keys=ON`, `busy_timeout=5000`.
- Server-authoritative sync: monotonic `seq`, idempotency keys, `base_rev` checks, tombstones, device acks. No CRDTs.
- One shared conversation per (user, primary agent); `messages.channel` records provenance.
- Auth on every endpoint except `POST /v1/auth/pair` and `GET /v1/health`. No default admin credentials.
- No long-lived bearer tokens in `localStorage`. PWA uses `HttpOnly`/`SameSite` cookies or a WebCrypto device credential.
- Core RSS ≤ **250 MB**, idle CPU ≤ **5 %**. No Node server in production.
- Release 1 scope only: no voice, Arduino, Tauri, workflows, or research tools.
- All Python commands run from `apps/orchestrator` with `uv run`.

## Review Focus

These are the failure modes most likely to bite, and the task that pins each with a test:

1. **Offline edits with skewed clocks or retries** — a phone must not silently overwrite a desktop edit or duplicate a message. Pinned in Task 5.
2. **Partial/malformed provider streams** — SSE comments, fragmented tool deltas, and HTTP-200 error payloads must not execute half a tool call. Pinned in Task 6.
3. **Stale or retracted memory** — superseded/retracted facts must never influence an answer. Pinned in Task 7.
4. **SSRF through URL fetching** — private IPs, link-local, and cloud metadata endpoints must be blocked, including after redirects. Pinned in Task 12.
5. **Duplicate job execution after a crash** — leases must make a retried job run once. Pinned in Task 11.

---

## File Structure

**Server (`apps/orchestrator/`):**

```
app/
  main.py                       # app factory + router registration
  config.py                     # settings (SQLite path, auth, providers)
  db/
    connection.py               # connect, pragmas, migration runner
    migrations/0001_initial.sql
    repositories/{users,devices,entities,conversations,messages,memories,sync,jobs,tool_calls,audit}.py
  auth/{tokens,pairing,dependencies}.py
  api/{auth,health,chat,sync,memory,models,jobs,errors}.py
  providers/{base,openai_compat,opencode_go,openrouter,registry}.py
  catalog/{normalize,cache}.py
  agent/{loop,context,prompts}.py
  memory/{service,indexer,tools}.py
  tools/{registry,monitor}.py
  scheduler/runner.py
  telegram/{client,bot}.py
  security/{ssrf,ratelimit}.py
tests/
  conftest.py
  test_db.py test_auth.py test_sync.py test_providers.py
  test_memory.py test_agent.py test_telegram.py test_scheduler.py test_security.py
```

**Client (`src/` and `public/`):**

```
src/lib/core/{types,client,db,sync}.ts
src/lib/core/*.test.ts
src/components/providers/CoreProvider.tsx
src/app/(app)/chat/[entityId]/ChatUI.tsx        # modify
src/app/offline/page.tsx                        # new
src/app/layout.tsx                              # register SW
src/app/manifest.ts                             # real icons
public/icons/icon-192.png, icon-512.png
public/sw.ts                                    # Serwist
scripts/check-static-export.mjs
```

**Deploy:**

```
deploy/potaeto-core.service
deploy/Caddyfile
deploy/README.md
scripts/backup.sh
scripts/smoke.sh
scripts/export_supabase.py
```

---

## Task 1: Next.js 16 + static export baseline

**Files:**
- Modify: `package.json`, `next.config.mjs`, `src/app/layout.tsx`, `.eslintrc.json`
- Create: `scripts/check-static-export.mjs`
- Test: `node scripts/check-static-export.mjs`

**Interfaces:**
- Consumes: current Next 14 app.
- Produces: a static `out/` build served by any static host; `npm run build` and `npm run lint` remain the verification commands.

- [ ] **Step 1: Write the failing static-export check**

Create `scripts/check-static-export.mjs`:

```js
import { existsSync } from 'node:fs';
const required = ['out/index.html', 'out/404.html'];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Missing static export files: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('static export OK');
```

Run: `node scripts/check-static-export.mjs`
Expected: FAIL with `Missing static export files: out/index.html, out/404.html`.

- [ ] **Step 2: Upgrade Next.js and React**

Run:

```bash
npm install next@16.4.6 react@19 react-dom@19
npm install -D eslint-config-next@16.4.6 @types/react@19 @types/react-dom@19
```

Expected: install completes; `npm ls next react` shows 16.4.6 / 19.x.

- [ ] **Step 3: Configure static export**

Modify `next.config.mjs`:

```js
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};
export default nextConfig;
```

Remove Supabase image `remotePatterns` (unused with `unoptimized`). If any page still uses `next/image` with a loader, replace it with a plain `<img>`.

- [ ] **Step 4: Fix Next 16 build errors**

Run: `npm run build`
Expected: FAIL initially on any Next 16 breaking changes. Fix iteratively; likely items:
- `params`/`searchParams` must be `Promise` in pages/layouts (the chat page already is).
- `next lint` may be removed; if so, change `"lint": "eslint ."` and add `eslint` to devDependencies.
- Remove `experimental` flags or APIs not supported by static export.

Run until: `npm run build` passes.

- [ ] **Step 5: Verify the static export**

Run:

```bash
node scripts/check-static-export.mjs
npx tsc --noEmit
npm run lint
```

Expected: all pass. `out/` contains `index.html` and `404.html`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json next.config.mjs scripts/check-static-export.mjs src .eslintrc.json
git commit -m "chore: upgrade to Next.js 16 and static export"
```

---

## Task 2: SQLite schema, migrations, and repositories

**Files:**
- Create: `apps/orchestrator/app/db/connection.py`, `apps/orchestrator/app/db/migrations/0001_initial.sql`, `apps/orchestrator/app/db/migrations/__init__.py`, `apps/orchestrator/app/db/repositories/*.py`, `apps/orchestrator/tests/conftest.py`, `apps/orchestrator/tests/test_db.py`
- Modify: `apps/orchestrator/pyproject.toml`

**Interfaces:**
- Produces:
  - `connect_db(path: str | Path) -> sqlite3.Connection`
  - `run_migrations(conn: sqlite3.Connection) -> None`
  - Repository classes with `create`, `get`, `list`, and (where mutable) `update` methods for `users`, `devices`, `entities`, `conversations`, `messages`, `memories`, `sync_changes`, `jobs`, `tool_calls`, `audit_events`. `SyncRepo` and `AuditRepo` are append-only and intentionally have no `update`.
  - `ConversationRepo.ensure_conversation(user_id, entity_id) -> Conversation`.
  - `MessageRepo.append(conversation_id, user_id, role, content, channel, meta) -> Message` assigns `seq` and `rev`.
  - `MessageRepo.last(conversation_id) -> Message | None`.

- [ ] **Step 1: Add pytest and write the failing DB tests**

Modify `apps/orchestrator/pyproject.toml` dev extras to include `pytest`, `pytest-asyncio`, `httpx`.

Create `tests/conftest.py`:

```python
import pytest
from app.db.connection import connect_db, run_migrations

@pytest.fixture()
def db(tmp_path):
    conn = connect_db(tmp_path / "test.db")
    run_migrations(conn)
    yield conn
    conn.close()
```

Create `tests/test_db.py`:

```python
from app.db.connection import connect_db, run_migrations

def test_pragmas(tmp_path):
    conn = connect_db(tmp_path / "test.db")
    assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2  # FULL

def test_migrations_are_idempotent(db):
    run_migrations(db)
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"messages", "sync_changes", "memories", "jobs"} <= tables

def test_message_append_assigns_monotonic_seq(db):
    from app.db.repositories.messages import MessageRepo
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    a = repo.append(conv.id, "u1", "user", "hello", "app", {})
    b = repo.append(conv.id, "u1", "assistant", "hi", "app", {})
    assert b.seq == a.seq + 1
    assert b.rev == 1

def test_fts_triggers_index_messages(db):
    from app.db.repositories.messages import MessageRepo
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    repo.append(conv.id, "u1", "user", "the quick brown fox", "app", {})
    rows = db.execute("SELECT content FROM messages_fts WHERE messages_fts MATCH 'brown'").fetchall()
    assert rows and "brown" in rows[0][0]
```

Run: `cd apps/orchestrator && uv run pytest tests/test_db.py -v`
Expected: FAIL with `ModuleNotFoundError: app.db`.

- [ ] **Step 2: Implement the connection and migration runner**

`app/db/connection.py`:

```python
def connect_db(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def run_migrations(conn: sqlite3.Connection) -> None:
    # read 0001_initial.sql once, execute statements, record schema_version
    ...
```

`0001_initial.sql` creates the tables from the spec §7.3 (users, devices, entities, conversations, messages, conversation_summaries, memories, memory_edges, sync_changes, device_sync_state, client_operations, model_catalog, settings, jobs, job_runs, tool_calls, approvals, audit_events, provider_usage, serial_events, audio_cache) plus:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

Repeat the trigger pattern for `memories_fts`. Add indexes on `messages(conversation_id, seq)`, `sync_changes(seq)`, `jobs(next_run, enabled)`.

Seed one local user and one primary agent so Release 1 has a single agent to chat with:

```sql
INSERT INTO users (id, name) VALUES ('u_local', 'Owner') ON CONFLICT DO NOTHING;
INSERT INTO entities (id, user_id, name, slug, persona_json, attributes_json)
VALUES ('e_potaeto', 'u_local', 'Potaeto', 'potaeto', '{}', '{}') ON CONFLICT DO NOTHING;
```

- [ ] **Step 3: Implement repositories**

Implement `UserRepo`, `DeviceRepo`, `EntityRepo`, `ConversationRepo`, `MessageRepo`, `MemoryRepo`, `SyncRepo`, `JobRepo`, `ToolCallRepo`, `AuditRepo` in `app/db/repositories/`. Keep each file focused. `MessageRepo.append` must set `seq = (SELECT COALESCE(MAX(seq),0)+1 FROM messages)` and `rev = 1` inside a transaction.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_db.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/db apps/orchestrator/tests apps/orchestrator/pyproject.toml
git commit -m "feat(core): add SQLite schema, migrations, and repositories"
```

---

## Task 3: Device auth and pairing

**Files:**
- Create: `apps/orchestrator/app/auth/tokens.py`, `app/auth/pairing.py`, `app/auth/dependencies.py`, `app/api/auth.py`, `tests/test_auth.py`
- Modify: `app/main.py`

**Interfaces:**
- Produces:
  - `hash_token(token: str) -> str` (SHA-256).
  - `PairingService.create_code(user_id: str, ttl_sec: int = 300) -> str`
  - `PairingService.exchange(code: str, device_name: str) -> PairResult` where `PairResult` has `device_id`, `token` (returned once), `user_id`.
  - `require_device(request) -> AuthContext` FastAPI dependency; raises 401.
  - `POST /v1/auth/pair` and `GET /v1/auth/me`.

- [ ] **Step 1: Write the failing auth tests**

Extend `tests/conftest.py` with a `client` fixture (FastAPI `TestClient` over an in-memory DB) and a `paired_device` fixture (creates a user, pairs a device, returns the `PairResult`). No HTTP mocking is needed for this task.

```python
def test_pairing_code_is_one_time(db):
    from app.auth.pairing import PairingService, PairingError
    svc = PairingService(db)
    code = svc.create_code("u1")
    first = svc.exchange(code, "phone")
    assert first.token
    with pytest.raises(PairingError):
        svc.exchange(code, "laptop")

def test_pairing_code_expires(db):
    svc = PairingService(db)
    code = svc.create_code("u1", ttl_sec=-1)
    with pytest.raises(PairingError):
        svc.exchange(code, "phone")

def test_token_is_stored_hashed(db):
    svc = PairingService(db)
    result = svc.exchange(svc.create_code("u1"), "phone")
    row = db.execute("SELECT token_hash FROM devices WHERE id=?", (result.device_id,)).fetchone()
    assert row["token_hash"] != result.token
    assert row["token_hash"] == hash_token(result.token)

def test_protected_endpoint_rejects_missing_token(client):
    assert client.get("/v1/auth/me").status_code == 401

def test_protected_endpoint_accepts_valid_token(client, paired_device):
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {paired_device.token}"})
    assert r.status_code == 200
    assert r.json()["device_id"] == paired_device.device_id
```

Run: `uv run pytest tests/test_auth.py -v` → FAIL.

- [ ] **Step 2: Implement tokens and pairing**

Use `secrets.token_urlsafe(32)` for device tokens and `secrets.token_hex(4)` for pairing codes. Store only `hash_token(token)`. Pairing codes are single-use and expire. Add `devices.revoked_at`.

- [ ] **Step 3: Implement the dependency and endpoints**

`require_device` reads `Authorization: Bearer <token>`, hashes it, looks up a non-revoked device, and returns `AuthContext(user_id, device_id)`. `POST /v1/auth/pair` accepts `{code, device_name}`; `GET /v1/auth/me` returns the device.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_auth.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/auth apps/orchestrator/app/api/auth.py apps/orchestrator/tests/test_auth.py apps/orchestrator/app/main.py
git commit -m "feat(core): add device pairing and bearer auth"
```

---

## Task 4: Core API skeleton

**Files:**
- Create: `app/api/health.py`, `app/api/errors.py`, `app/main.py` app factory, `tests/test_api.py`

**Interfaces:**
- Produces: `create_app(settings) -> FastAPI`; `GET /v1/health` returns `{status, version, db, uptime_sec}`; a JSON error envelope `{error: {code, message}}`.
- Consumes: Task 2 `connect_db`/`run_migrations`, Task 3 `require_device`.

- [ ] **Step 1: Write the failing API tests**

```python
def test_health_is_public(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

def test_unknown_route_returns_json_error(client):
    r = client.get("/v1/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
```

- [ ] **Step 2: Implement the app factory and health route**

`create_app` loads settings, opens the DB, runs migrations, mounts routers, and registers an exception handler that returns the JSON error envelope.

- [ ] **Step 3: Run the tests + a live smoke**

Run: `uv run pytest tests/test_api.py -v` → PASS.
Run: `uv run uvicorn app.main:app --port 8000` then `curl -s localhost:8000/v1/health` → `{"status":"ok",...}`. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/app/main.py apps/orchestrator/app/api apps/orchestrator/tests/test_api.py
git commit -m "feat(core): add app factory, health route, and error envelope"
```

---

## Task 5: Server-authoritative sync

**Files:**
- Create: `app/db/repositories/sync.py`, `app/api/sync.py`, `tests/test_sync.py`
- Modify: `app/db/migrations/0001_initial.sql` (if a column is missing)

**Interfaces:**
- Produces:
  - `SyncRepo.record_change(entity_type, entity_id, operation, payload) -> int` (returns `seq`).
  - `SyncRepo.get_changes(after_seq: int, limit: int) -> list[SyncChange]`.
  - `SyncRepo.ack(device_id: str, seq: int) -> None`.
  - `SyncRepo.push(device_id: str, operations: list[PushOperation]) -> list[PushResult]`.
  - `GET /v1/sync?after_seq=&limit=`, `POST /v1/sync/push`, `POST /v1/sync/ack`.

- [ ] **Step 1: Write the failing sync tests**

```python
def test_push_is_idempotent(db):
    from app.db.repositories.sync import SyncRepo, PushOperation
    repo = SyncRepo(db)
    op = PushOperation("k1", "message", "m1", 0, {"content": "hello"})
    first = repo.push("d1", [op])
    second = repo.push("d1", [op])
    assert first[0].status == "applied"
    assert second[0].status == "duplicate"
    assert first[0].seq == second[0].seq
    assert db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1

def test_stale_base_rev_returns_conflict(db):
    ...
    assert result.status == "conflict"
    assert result.error == "stale_rev"

def test_seq_is_monotonic_and_cursor_works(db):
    s1 = repo.record_change("message", "m1", "insert", {})
    s2 = repo.record_change("message", "m2", "insert", {})
    assert s2 == s1 + 1
    assert [c.seq for c in repo.get_changes(s1, 10)] == [s2]

def test_ack_is_per_device(db):
    repo.ack("d1", 5)
    repo.ack("d2", 3)
    assert repo.last_ack("d1") == 5
    assert repo.last_ack("d2") == 3
```

Run: `uv run pytest tests/test_sync.py -v` → FAIL.

- [ ] **Step 2: Implement the sync repository**

Every applied write inserts a `sync_changes` row and sets `seq`. `client_operations` stores the idempotency key and result. On a duplicate key, return the stored result. On `base_rev` mismatch, return `conflict` with the current row. Tombstones are rows with `deleted=1`; keep them until all devices ack.

- [ ] **Step 3: Implement the endpoints**

`GET /v1/sync` returns `{changes, next_seq, has_more}`. `POST /v1/sync/push` returns `{results}`. `POST /v1/sync/ack` returns `{ok: true}`. All require `require_device`.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_sync.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/db/repositories/sync.py apps/orchestrator/app/api/sync.py apps/orchestrator/tests/test_sync.py
git commit -m "feat(core): add server-authoritative sync protocol"
```

---

## Task 6: Provider abstraction, catalog, and streaming

**Files:**
- Create: `app/providers/base.py` (extend), `app/providers/openai_compat.py` (refactor), `app/providers/opencode_go.py`, `app/providers/openrouter.py`, `app/providers/registry.py`, `app/catalog/normalize.py`, `app/catalog/cache.py`, `tests/test_providers.py`
- Modify: `app/config.py`, `pyproject.toml` (add `pytest-httpx`)

**Interfaces:**
- Produces:
  - `ModelInfo(provider, id, name, context_length, max_output_tokens, supports_tools, protocol, pricing, retention)`.
  - `ChatRequest(model, messages, tools=None, temperature=None, max_tokens=None)`.
  - `StreamEvent` union: `token(text)`, `tool_call_delta(index, id, name, args)`, `done(finish_reason, usage)`, `error(code, message)`.
  - `Provider.list_models() -> list[ModelInfo]`, `Provider.stream_chat(req) -> AsyncIterator[StreamEvent]`.
  - `ProviderRegistry.from_settings(settings)`.
  - `CatalogCache.get(provider) -> list[ModelInfo]` with TTL.

- [ ] **Step 1: Write the failing provider tests**

Run: `uv add --dev pytest-httpx`. Then add the tests:

```python
async def test_opencode_discovery_is_anonymous(httpx_mock):
    httpx_mock.add_response(url="https://opencode.ai/inference/go/v1/models", json={"data": [...]})
    provider = OpenCodeGoProvider(api_key="oc_sk_test")
    models = await provider.list_models()
    request = httpx_mock.get_requests()[0]
    assert "authorization" not in request.headers
    assert models[0].id

async def test_opencode_inference_sends_session_header(httpx_mock):
    httpx_mock.add_response(method="POST", json={"choices": [{"delta": {"content": "hi"}}]})
    provider = OpenCodeGoProvider(api_key="oc_sk_test", session_id="ses_" + "a" * 32)
    _ = [e async for e in provider.stream_chat(ChatRequest(...))]
    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer oc_sk_test"
    assert request.headers["x-opencode-session"] == "ses_" + "a" * 32

async def test_opencode_401_falls_back_to_anonymous_discovery(httpx_mock):
    httpx_mock.add_response(status_code=401, json={"error": "bad key"})
    httpx_mock.add_response(json={"data": [...]})  # anonymous retry
    models = await OpenCodeGoProvider(api_key="bad").list_models()
    assert models

async def test_openrouter_model_projection(httpx_mock):
    httpx_mock.add_response(json={"data": [{"id": "x", "context_length": 8192, "pricing": {"prompt": "0.000001"}}]})
    models = await OpenRouterProvider(api_key="k").list_models()
    assert models[0].context_length == 8192

async def test_openrouter_stream_error_is_reported(httpx_mock):
    # HTTP 200 with {"error": {"message": "upstream failed"}, "finish_reason": "error"}
    events = [e async for e in provider.stream_chat(...)]
    assert any(e.type == "error" for e in events)
```

Run: `uv run pytest tests/test_providers.py -v` → FAIL.

- [ ] **Step 2: Implement the OpenAI-compatible base**

Refactor `openai_compat.py` to expose a streaming SSE parser that handles comments, fragmented events, and `[DONE]`. Accumulate tool deltas by `index`; do not execute anything here. Map `finish_reason` and usage.

- [ ] **Step 3: Implement OpenCode Go**

Discovery uses `GET https://opencode.ai/inference/go/v1/models` with **no** `Authorization`. On 401/403, retry anonymously, then `/inference/v1/models`, then `models.dev/api.json`, then the bundled snapshot. Normalize the live `api` map into `protocol`. Inference base `https://opencode.ai/inference/go`; chat at `/openai/v1/chat/completions`; send `Authorization` and `x-opencode-session`.

- [ ] **Step 4: Implement OpenRouter + registry + cache**

OpenRouter discovery `GET https://openrouter.ai/api/v1/models`; project fields; cache 24 h with ETag. Inference `POST /api/v1/chat/completions`; `Authorization: Bearer`. Parse the extra usage chunk and treat mid-stream `error` as an error event.

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_providers.py -v` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/app/providers apps/orchestrator/app/catalog apps/orchestrator/app/config.py apps/orchestrator/tests/test_providers.py
git commit -m "feat(core): add OpenCode Go and OpenRouter providers with catalog caching"
```

---

## Task 7: Memory governance and `agent-memory` indexer

**Files:**
- Create: `app/memory/service.py`, `app/memory/indexer.py`, `app/memory/tools.py`, `tests/test_memory.py`
- Modify: `app/db/migrations/0001_initial.sql` (memory columns)

**Interfaces:**
- Produces:
  - `MemoryService.add(user_id, entity_id, kind, content, source, source_ref, confidence, scope, sensitivity, user_confirmed) -> Memory`
  - `MemoryService.search(user_id, query, limit=10) -> list[Memory]` (active only)
  - `MemoryService.recall(memory_id) -> Memory`
  - `MemoryService.update(memory_id, content=None, confidence=None) -> Memory`
  - `MemoryService.supersede(old_id, new_id) -> None`
  - `MemoryService.retract(memory_id) -> None`
  - `MemoryIndexer.reindex(root: Path) -> int`
  - `MemoryTools` wrapper for the agent.

- [ ] **Step 1: Write the failing memory tests**

```python
def test_add_and_search(db):
    svc = MemoryService(db)
    m = svc.add("u1", "e1", "fact", "Alex uses OpenCode Go", "user", None, 0.9, "global", "normal", True)
    assert m.id in [r.id for r in svc.search("u1", "OpenCode")]

def test_retracted_memory_is_not_retrieved(db):
    svc = MemoryService(db)
    m = svc.add(...)
    svc.retract(m.id)
    assert svc.search("u1", "OpenCode") == []

def test_supersede_hides_old_fact(db):
    old = svc.add(..., "Alex uses Provider A")
    new = svc.add(..., "Alex uses Provider B")
    svc.supersede(old.id, new.id)
    assert svc.recall(old.id).status == "superseded"
    assert [m.id for m in svc.search("u1", "Provider")] == [new.id]

def test_web_fact_is_candidate_not_confirmed(db):
    m = svc.add(..., source="web", user_confirmed=False)
    assert m.user_confirmed is False
    assert m.confidence < 0.9

def test_indexer_upserts_only_changed_nodes(db, tmp_path):
    root = tmp_path / "agent-memory"
    (root / "projects" / "potaeto").mkdir(parents=True)
    (root / "projects" / "potaeto" / "a.md").write_text("---\nid: a\ntitle: A\n---\nbody")
    idx = MemoryIndexer(db)
    assert idx.reindex(root) == 1
    assert idx.reindex(root) == 0  # unchanged
```

Run: `uv run pytest tests/test_memory.py -v` → FAIL.

- [ ] **Step 2: Implement the service and indexer**

Status transitions: `active` → `superseded` (when a newer memory replaces it) or `retracted`. Retrieval filters `status='active'` and `valid_to IS NULL OR valid_to > now`. The indexer reads frontmatter, hashes content, and upserts changed nodes into `memories` + `memories_fts`.

- [ ] **Step 3: Implement the agent tools**

`memory_search`, `memory_recall`, `memory_add`, `memory_update`, `memory_supersede`, `memory_retract`, `memory_journal`. Writes require a `source` and default `user_confirmed=False` unless the user explicitly confirmed.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_memory.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/memory apps/orchestrator/app/db/migrations/0001_initial.sql apps/orchestrator/tests/test_memory.py
git commit -m "feat(core): add governed memory and agent-memory indexer"
```

---

## Task 8: Agent loop, context, and chat streaming

**Files:**
- Create: `app/agent/loop.py`, `app/agent/context.py`, `app/agent/prompts.py`, `app/api/chat.py`, `tests/test_agent.py`
- Modify: `app/main.py`

**Interfaces:**
- Produces:
  - `AgentEvent` union: `token`, `tool_call`, `tool_result`, `done`, `error`.
  - `AgentLoop(db, provider, memory, tools)` with `run(conversation_id, user_message, channel) -> AsyncIterator[AgentEvent]`.
  - `ContextBuilder(db)` with `build(user_id, entity_id, conversation_id, user_message) -> list[TextMessage]`.
  - `POST /v1/chat/stream` (SSE) with `{conversation_id, message}`.
  - `GET /v1/agent` returns the primary entity (`e_potaeto`).
  - A per-conversation turn queue; a concurrent request returns `{status: "queued", position}`.

- [ ] **Step 1: Write the failing agent tests**

```python
async def test_single_turn_streams_and_persists(db, fake_provider):
    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    events = [e async for e in loop.run(conv, "hello", "app")]
    assert [e.type for e in events][-1] == "done"
    assert MessageRepo(db).last(conv).content == "Hi"

async def test_tool_call_loop_executes_and_feeds_result(db, fake_provider):
    # provider returns tool_call(memory_search) then final text
    events = [e async for e in loop.run(conv, "what do I like?", "app")]
    assert any(e.type == "tool_call" for e in events)
    assert any(e.type == "tool_result" for e in events)
    assert events[-1].type == "done"

async def test_context_respects_budget(db, fake_provider):
    ctx = ContextBuilder(db).build(...)
    assert sum(len(m.content) for m in ctx) <= 8_000 * 4

async def test_concurrent_turn_is_queued(db, slow_provider):
    first = loop.run(conv, "one", "app")
    second = loop.run(conv, "two", "app")
    # drain first, then second; assert order and no interleaving
```

Run: `uv run pytest tests/test_agent.py -v` → FAIL.

- [ ] **Step 2: Implement context assembly**

Pinned persona/facts + last 10 messages + top 8 memory nodes + summary. Token estimate `chars/4`; cap at the dynamic budget derived from the model catalog `context_length` (floor/ceiling); the fixed 8k cap was raised after Release 1; include memory IDs in the prompt so the model can cite them.

- [ ] **Step 3: Implement the loop and turn queue**

Max 8 tool turns. Execute tools only after complete arguments. Persist the assistant message and a summary trigger. The per-conversation `asyncio.Lock`/queue serializes turns.

- [ ] **Step 4: Implement the SSE endpoint**

`POST /v1/chat/stream` requires `require_device`, validates the conversation belongs to the user, and streams `event: token|tool_call|tool_result|done|error` + JSON data. Include `X-Conversation-Id`.

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_agent.py -v` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/app/agent apps/orchestrator/app/api/chat.py apps/orchestrator/tests/test_agent.py apps/orchestrator/app/main.py
git commit -m "feat(core): add agent loop, context budget, and SSE chat"
```

---

## Task 9: PWA client — core client, IndexedDB cache, outbox, and chat UI

**Files:**
- Create: `src/lib/core/types.ts`, `src/lib/core/client.ts`, `src/lib/core/db.ts`, `src/lib/core/sync.ts`, `src/lib/core/*.test.ts`, `src/components/providers/CoreProvider.tsx`, `src/app/chat/page.tsx`, `src/app/offline/page.tsx`, `public/sw.js`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `vitest.config.ts`
- Modify: `src/app/(app)/chat/[entityId]/ChatUI.tsx`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/manifest.ts`, `package.json`

**Interfaces:**
- Produces:
  - `new CoreClient({ baseUrl: string })` with `chatStream(input) -> AsyncIterable<AgentEvent>`
  - `CoreClient.sync(afterSeq) -> SyncResponse`
  - `CoreClient.push(operations) -> PushResult[]`
  - `LocalDb` (Dexie) with `messages`, `outbox`, `meta` tables.
  - `SyncEngine.flush() -> FlushResult` and `SyncEngine.pull()`.
- Consumes: Tasks 4/5/8 endpoints.

**Scope note:** Release 1 uses Dexie/IndexedDB as the PWA cache. The repository interface is driver-based so sqlite-wasm/OPFS can replace it in Release 3 without changing callers. Static export cannot use a dynamic `/chat/[entityId]` route with an unknown build-time ID; Release 1 uses a single `/chat` route for the primary agent, and multi-agent dynamic routes return in Release 3.

- [ ] **Step 1: Add Vitest and write the failing sync tests**

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom
```

`vitest.config.ts` with `environment: 'jsdom'`, `setupFiles`.

`src/lib/core/sync.test.ts`:

```ts
it('queues offline messages and flushes idempotently', async () => {
  const db = new LocalDb('test');
  const client = { push: vi.fn().mockResolvedValue([{ idempotencyKey: 'k1', status: 'applied', seq: 7 }]) };
  const sync = new SyncEngine(db, client as any);
  await db.outbox.add({ idempotencyKey: 'k1', entityType: 'message', entityId: 'm1', baseRev: 0, payload: {} });
  await sync.flush();
  await sync.flush();
  expect(client.push).toHaveBeenCalledTimes(2);
  expect(await db.outbox.count()).toBe(0);
});

it('keeps the outbox on a network failure', async () => {
  const client = { push: vi.fn().mockRejectedValue(new Error('offline')) };
  await expect(sync.flush()).resolves.toMatchObject({ failed: 1 });
  expect(await db.outbox.count()).toBe(1);
});
```

Run: `npx vitest run src/lib/core/sync.test.ts` → FAIL.

- [ ] **Step 2: Implement the client and local DB**

`CoreClient` uses `fetch` with `credentials: 'include'` for the PWA. `chatStream` parses SSE `event:`/`data:` frames. `LocalDb` uses Dexie with `messages`, `outbox`, `meta` (cursor). `SyncEngine.flush` sends idempotency keys and clears only applied/duplicate entries.

- [ ] **Step 3: Implement the PWA shell**

- `src/app/manifest.ts`: name `Potaeto`, icons 192/512, `display: 'standalone'`, `start_url: '/'`.
- `public/sw.ts`: Serwist precache of the static export + `/offline`.
- `src/app/offline/page.tsx`: simple offline message.
- `src/app/layout.tsx`: register the service worker in a client component.
- `public/icons/`: add real PNGs (generate simple potato icons).

- [ ] **Step 4: Wire the chat UI and add the active route**

Modify `ChatUI.tsx` to use `CoreClient.chatStream` instead of `/api/ai/chat` and `/api/guest/ai/chat`. Load history from `LocalDb`; on send, append to `LocalDb` and the outbox, then stream. On reconnect, `SyncEngine.flush()` then `pull()`.

Create `src/app/chat/page.tsx` as a client route that renders `ChatUI` for the primary agent (`entityId='e_potaeto'`, `entityName='Potaeto'`, fetched from `GET /v1/agent`). Point the landing page's primary CTA at `/chat`.

- [ ] **Step 5: Run the tests and build**

Run: `npx vitest run` → PASS.
Run: `npm run build` and `node scripts/check-static-export.mjs` → PASS.
Manual: `npm run dev`, load `/`, verify the manifest and offline page.

- [ ] **Step 6: Commit**

```bash
git add src/lib/core src/components/providers src/app public vitest.config.ts package.json
git commit -m "feat(pwa): add core client, IndexedDB cache, outbox, and offline shell"
```

---

## Task 10: Telegram bot

**Files:**
- Create: `app/telegram/client.py`, `app/telegram/bot.py`, `tests/test_telegram.py`
- Modify: `app/config.py`, `app/main.py`

**Interfaces:**
- Produces:
  - `TelegramClient.get_updates(offset, timeout) -> list[dict]`, `send_message(chat_id, text)`.
  - `TelegramBot(client, db, agent_loop, allowed_chat_ids)` with `handle_update(update) -> bool` (returns True if processed) and `run_forever()` — long polling, persists update IDs, acks after durable processing.
- Consumes: Task 8 `AgentLoop`.

- [ ] **Step 1: Write the failing Telegram tests**

```python
async def test_allowlist_rejects_unknown_chat(bot):
    update = {"update_id": 1, "message": {"chat": {"id": 999}, "text": "hi"}}
    assert await bot.handle_update(update) is False
    assert bot.client.sent == []

async def test_allowed_chat_routes_to_agent(bot, fake_loop):
    update = {"update_id": 2, "message": {"chat": {"id": 123}, "text": "hi"}}
    assert await bot.handle_update(update) is True
    assert fake_loop.calls == [("hi", "telegram")]

async def test_update_id_is_persisted_before_ack(bot):
    await bot.handle_update(update)
    assert db.execute("SELECT update_id FROM telegram_updates").fetchone()[0] == 2

async def test_long_message_is_split(bot):
    bot.send_long(123, "x" * 5000)
    assert len(bot.client.sent) == 2
```

Run: `uv run pytest tests/test_telegram.py -v` → FAIL.

- [ ] **Step 2: Implement the client and bot**

Long polling with `getUpdates(offset, timeout=50)`. Allowlist from `TELEGRAM_ALLOWED_CHAT_IDS`. Persist `telegram_updates(update_id)`; insert before processing, ack after. Commands: `/start`, `/status`, `/model`, `/jobs`, `/memory`. Free text routes to `AgentLoop` with `channel="telegram"`.

- [ ] **Step 3: Run the tests**

Run: `uv run pytest tests/test_telegram.py -v` → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/app/telegram apps/orchestrator/app/config.py apps/orchestrator/app/main.py apps/orchestrator/tests/test_telegram.py
git commit -m "feat(core): add allowlisted Telegram bot"
```

---

## Task 11: Monitor tools and durable scheduler

**Files:**
- Create: `app/tools/monitor.py`, `app/scheduler/runner.py`, `app/api/jobs.py`, `tests/test_monitor.py`, `tests/test_scheduler.py`

**Interfaces:**
- Produces:
  - `MonitorTools.system_health() -> dict` (CPU temp, load, RAM, disk).
  - `MonitorTools.http_ping(url) -> dict` (status, latency).
  - `Scheduler(db)` with `create_job(name, schedule, timezone, workflow_json) -> Job`.
  - `Scheduler.lease_due(now) -> list[Job]` (atomic `lease_owner`/`lease_until`).
  - `Scheduler.complete(job_id, status, output)`.
  - `GET/POST /v1/jobs`.

- [ ] **Step 1: Write the failing scheduler tests**

```python
def test_lease_prevents_duplicate_run(db):
    s = Scheduler(db)
    job = s.create_job("briefing", "0 8 * * *", "Asia/Kolkata", {"steps": []})
    first = s.lease_due(now=job.next_run)
    second = s.lease_due(now=job.next_run)
    assert [j.id for j in first] == [job.id]
    assert second == []

def test_expired_lease_is_reclaimable(db):
    ...
    assert [j.id for j in s.lease_due(now=lease_until + 1)] == [job.id]

def test_completion_advances_next_run(db):
    ...
    assert job.next_run > previous

def test_system_health_returns_thresholds(db):
    h = MonitorTools(db).system_health()
    assert {"cpu_temp_c", "load_1m", "mem_available_mb", "disk_used_pct"} <= h.keys()
```

Run: `uv run pytest tests/test_scheduler.py tests/test_monitor.py -v` → FAIL.

- [ ] **Step 2: Implement monitor tools**

Read `/sys/class/thermal/thermal_zone*/temp`, `/proc/loadavg`, `/proc/meminfo`, and `shutil.disk_usage("/")`. Return `None` for unavailable sensors; never raise.

- [ ] **Step 3: Implement the scheduler**

SQLite transactions with `UPDATE jobs SET lease_owner=?, lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until < ?)`. One worker loop; no APScheduler. Misfire policy: run once if missed, then advance.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_scheduler.py tests/test_monitor.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/tools/monitor.py apps/orchestrator/app/scheduler apps/orchestrator/app/api/jobs.py apps/orchestrator/tests/test_scheduler.py apps/orchestrator/tests/test_monitor.py
git commit -m "feat(core): add monitor tools and leased scheduler"
```

---

## Task 12: Security baseline

**Files:**
- Create: `app/security/ssrf.py`, `app/security/ratelimit.py`, `app/audit.py`, `tests/test_security.py`
- Modify: `app/api/errors.py`, `app/main.py`

**Interfaces:**
- Produces:
  - `SSRFSafeFetcher.fetch(url, max_bytes=2_000_000, timeout=10) -> FetchResult`.
  - `RateLimiter.check(key, limit, window_sec) -> bool`.
  - `AuditLog(db).record(actor, kind, subject, detail)`.
  - `ADMIN_SECRET` unset → admin routes return 503.

- [ ] **Step 1: Write the failing security tests**

```python
@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.0.10/",  # pii-scan: allow-private-ip
    "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd",  # pii-scan: allow-private-ip
])
async def test_ssrf_blocks_private_targets(url):
    with pytest.raises(SSRFError):
        await SSRFSafeFetcher().fetch(url)

async def test_redirect_to_private_is_blocked():
    # first response 302 -> http://127.0.0.1/
    with pytest.raises(SSRFError):
        await fetcher.fetch("https://example.com/redirect")

def test_rate_limit_blocks_after_limit():
    rl = RateLimiter()
    assert rl.check("k", 2, 60)
    assert rl.check("k", 2, 60)
    assert not rl.check("k", 2, 60)

def test_admin_disabled_without_secret(client, monkeypatch):
    monkeypatch.delenv("ADMIN_SECRET", raising=False)
    assert client.get("/v1/admin/anything").status_code == 503
```

Run: `uv run pytest tests/test_security.py -v` → FAIL.

- [ ] **Step 2: Implement SSRF-safe fetching**

Resolve the hostname; reject private/loopback/link-local/metadata IPs; allow only `http`/`https`; revalidate after each redirect (max 3); cap bytes and time; stream to a buffer.

- [ ] **Step 3: Implement rate limiting, audit, and admin guard**

In-memory token bucket per device/chat (single process). Audit writes to `audit_events`. Admin dependency returns 503 if `ADMIN_SECRET` is unset.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_security.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/security apps/orchestrator/app/audit.py apps/orchestrator/app/api/errors.py apps/orchestrator/app/main.py apps/orchestrator/tests/test_security.py
git commit -m "feat(core): add SSRF protection, rate limits, audit, and admin guard"
```

---

## Task 13: Deployment, backup, export, and smoke

**Files:**
- Create: `deploy/potaeto-core.service`, `deploy/Caddyfile`, `deploy/README.md`, `scripts/backup.sh`, `scripts/smoke.sh`, `scripts/export_supabase.py`
- Modify: `.env.example`

**Interfaces:**
- Produces: a documented systemd + Caddy deployment; a smoke script that exercises health, pairing, sync, and chat; a Supabase export script.

- [ ] **Step 1: Write the systemd unit and Caddyfile**

`deploy/potaeto-core.service`:

```ini
[Service]
User=potaeto
WorkingDirectory=/opt/potaeto/apps/orchestrator
EnvironmentFile=/opt/potaeto/.env
ExecStart=/opt/potaeto/apps/orchestrator/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
MemoryMax=512M
CPUQuota=200%
Nice=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/potaeto/data /home/operator/agent-memory
Restart=on-failure
```

`deploy/Caddyfile`:

```
:8080 {
  handle /v1/* { reverse_proxy 127.0.0.1:8000 }
  handle { root * /opt/potaeto/out; try_files {path} /index.html; file_server }
}
```

- [ ] **Step 2: Write backup and export scripts**

`scripts/backup.sh` uses `sqlite3 "$DB" ".backup '$DEST'"`, gzips, and keeps 7 daily + 4 weekly. `scripts/export_supabase.py` reads `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` and exports `entities`, `conversations`, `messages`, `memories`, `conversation_summaries` to JSON; run with `--dry-run` against a fixture.

- [ ] **Step 3: Write the smoke script**

`scripts/smoke.sh`:
1. `curl -fsS localhost:8000/v1/health` → `ok`.
2. Create a pairing code (test-only endpoint or CLI), exchange it, assert a token.
3. `POST /v1/sync/push` with a message; assert `applied`.
4. `GET /v1/sync?after_seq=0`; assert the message.
5. `POST /v1/chat/stream` with a fake provider; assert an SSE `done` event.

- [ ] **Step 4: Verify**

Run: `systemd-analyze verify deploy/potaeto-core.service` → no errors.
Run: `caddy validate --config deploy/Caddyfile` → valid.
Run: `bash scripts/smoke.sh` → all checks pass.
Run: `python scripts/export_supabase.py --dry-run` → prints counts, no writes.

- [ ] **Step 5: Commit**

```bash
git add deploy scripts .env.example
git commit -m "chore: add systemd, Caddy, backup, export, and smoke scripts"
```

---

## Self-Review

**Spec coverage (Release 1):**

| Spec requirement | Task |
|---|---|
| Next.js 16 + static export | 1 |
| SQLite schema + repositories | 2 |
| Device pairing + auth | 3 |
| Core API + health | 4 |
| Server-authoritative sync (`seq`, idempotency, `base_rev`, tombstones, acks) | 5 |
| OpenCode Go + OpenRouter catalog/streaming | 6 |
| Governed memory + `agent-memory` indexer + evals | 7 |
| Agent loop + context budget + SSE chat + turn queue | 8 |
| PWA chat + IndexedDB cache + outbox + offline shell | 9 |
| Telegram bot + allowlist + durable update IDs | 10 |
| Monitor tools + leased scheduler | 11 |
| SSRF, rate limits, audit, admin guard | 12 |
| Deployment, backup, export, smoke | 13 |

**Deferred to later plans (not gaps):** Tauri desktop/Android, voice worker, Arduino bridge, Lens OS research harness, workflows, proactive messages, sqlite-wasm/OPFS, FCM/push, memory vector search.

**Type consistency:** `AuthContext(user_id, device_id)`, `PushOperation(idempotency_key, entity_type, entity_id, base_rev, payload)`, `PushResult(idempotency_key, status, rev, seq, error)`, `ModelInfo(...)`, `AgentEvent(type, data)` are used consistently across tasks.

**Review Focus coverage:** offline/clock skew → Task 5; provider stream errors → Task 6; stale/retracted memory → Task 7; SSRF → Task 12; duplicate jobs → Task 11.

**Proportion:** this plan is a task map, not a code transcript; bodies are left to the implementer except where the spec pins exact values or protocols.
