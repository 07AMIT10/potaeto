# Potaeto Release 2 — Give It Capabilities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the capability layer to the Release 1 persistent agent: exact expiring tool approvals, sandboxed `run_command` with bubblewrap, Lens OS research MCP harness (`lens-mcp`), Arduino Nano 33 BLE Sense Rev2 serial bridge and LED/telemetry controls, isolated voice worker (Piper TTS + Whisper.cpp STT), proactive workflows engine, full 75% summary rollup, memory governance UI, and the 7-scenario memory evaluation suite.

**Architecture:** 
- The FastAPI orchestrator (`apps/orchestrator`, `:8010`) extends its tool loop with an `approvals` table and exact action hashing.
- High-risk shell commands execute via `/usr/bin/bwrap` inside an unshared mount/network namespace restricted to `data/sandbox`.
- Research queries are delegated over stdio JSON-RPC 2.0 to a native Rust `lens-mcp` binary in `lens-native` utilizing `lens-grounding`.
- Hardware telemetry and active-low RGB LED actuation run via non-blocking serial to `/dev/potaeto-arduino`.
- Speech synthesis and transcription run in an isolated `potaeto-voice.service` cgroup (`MemoryMax=1G`) with audio disk caching.
- Context rolling summary compresses conversation histories exceeding 75% of model limits.
- Memory governance UI and 7 automated pytest evaluations enforce memory lifecycle integrity.

**Tech Stack:** Python 3.11+ / FastAPI / SQLite / Bubblewrap (`bwrap`) / `pyserial-asyncio` / Piper TTS / Whisper.cpp / Rust (Lens OS `lens-mcp`) / Next.js 16.4.6 / React 19 / TypeScript / Tailwind CSS / systemd / Telegram Bot API.

**Spec Reference:** `docs/superpowers/specs/2026-11-11-potaeto-sentient-agent-design.md` §7.6, §7.7, §7.8, §7.10, §7.11, §8, §9.

---

## Global Constraints

- Must preserve OSS and PII safety rule: no real names, private IPs, personal domains, home usernames, or credentials in git tracked files. Use placeholders (`192.0.2.10`, `example.com`, `<user>`).
- Core binds `127.0.0.1:8010` on `force` (`http://localhost:8010`). Caddy listens on `:8080`.
- All Python commands run from `apps/orchestrator` with `uv run`.
- All frontend commands run from repo root with `npm run`.
- SQLite: `journal_mode=WAL`, `synchronous=FULL` for canonical tables, `foreign_keys=ON`, `busy_timeout=5000`. Telemetry `serial_events` uses bounded retention (7 days detailed).
- Process RSS budget: core idle ≤ 250 MB, voice worker idle ≤ 80 MB (peak 1 GB cgroup ceiling).
- Approvals are exact, cryptographic (`sha256(tool_name + canonical_args)`), expiring, and strictly one-time-use.
- Subagent model restriction: use only `opencode-go/deepseek-v4.1-flash` for subagents.
- External repo changes to `lens-native` require explicit user consent per its `AGENTS.md`.

---

## File Structure

```
apps/orchestrator/
  app/
    db/
      migrations/
        0005_approvals.sql                      # Approvals table & tool_calls lifecycle columns
        0006_serial_events.sql                   # Bounded hardware telemetry retention
      repositories/
        approvals.py                             # ApprovalRepo
        serial_events.py                         # SerialEventsRepo
      connection.py                              # Register new migrations
    api/
      approvals.py                             # GET /v1/approvals/pending, POST /v1/approvals/{id}/resolve
      voice.py                                 # POST /v1/voice/transcribe, POST /v1/voice/synthesize
      hardware.py                              # GET /v1/hardware/telemetry, POST /v1/hardware/led
    tools/
      run_command.py                           # Sandboxed execution via bwrap
      lens_mcp.py                              # Stdio JSON-RPC client to lens-mcp
      arduino.py                               # Arduino tools: led, read, pattern
    hardware/
      arduino.py                               # Async serial bridge to /dev/potaeto-arduino
    voice/
      tts.py                                   # Piper TTS client with sha256 disk cache
      stt.py                                   # Whisper.cpp CLI runner
    workflows/
      engine.py                                # JSON workflow step list interpreter
      steps.py                                 # Step implementations (tool, llm, condition, notify, memory_add)
    agent/
      loop.py                                  # Tool approval interception & context rollup integration
      context.py                               # 75% summary rollup compressor
      prompts.py                               # Updated tool use & memory scope guidance
    telegram/
      bot.py                                   # Inline approval keyboards & voice note transcriber
  tests/
    test_approvals.py                          # Approval lifecycle and hashing tests
    test_run_command.py                        # Sandbox isolation, timeout, network tests
    test_lens_mcp.py                           # Lens MCP stdio client tests & fallbacks
    test_arduino.py                            # Serial protocol v1, ack, and telemetry tests
    test_voice.py                              # Piper audio cache & whisper runner tests
    test_workflows.py                          # Workflow engine & lease tests
    test_context_summary.py                    # 75% rollup compression tests
    test_memory_evals.py                       # 7 spec memory evaluations

src/
  lib/
    core/
      types.ts                                 # Approval, hardware, and voice types
      client.ts                                # API client methods for approvals & hardware
      db.ts                                    # Fix offline retry client_message_id dedup bug
  components/
    chat/
      ApprovalModal.tsx                        # PWA interactive approval dialog
      ChatUI.tsx                               # Wire approval modal and retry dedup
    hardware/
      ArduinoPanel.tsx                         # Live sensor dashboard & LED controls
    memory/
      MemoryGovernance.tsx                     # Retract, supersede, confirm facts UI
  app/
    memory/page.tsx                            # Memory governance page
    hardware/page.tsx                          # Hardware telemetry page

deploy/
  potaeto-voice.service                        # Voice worker systemd unit with MemoryMax=1G
scripts/
  smoke-release-2.sh                           # End-to-end capability verification script
```

---

## Tasks

### Task 1: Fix Release 1 Residuals (Offline Retry Dedup & Memory Scope Default)

**Files:**
- Modify: `src/lib/core/db.ts:40-90`
- Modify: `src/app/chat/ChatUI.tsx:110-160`
- Modify: `apps/orchestrator/app/memory/service.py:30-80`
- Modify: `apps/orchestrator/app/agent/prompts.py:20-50`
- Test: `src/lib/core/retry_dedup.test.ts` (Vitest)
- Test: `apps/orchestrator/tests/test_memory_scope.py` (Pytest)

**Interfaces:**
- Consumes: Dexie outbox records and `MemoryService.add`.
- Produces: `retryMessage(id)` retains original `client_message_id`; memory default scope is `project:Anveshak`.

- [ ] **Step 1: Write failing frontend test for retry deduplication**

Create `src/lib/core/retry_dedup.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { db, saveOutboxMessage, getOutboxMessages, retryOutboxMessage } from './db';

describe('Offline message retry deduplication', () => {
  beforeEach(async () => {
    await db.outbox.clear();
  });

  it('preserves the original client_message_id upon retry without minting a new one', async () => {
    const originalClientMsgId = 'client-msg-123';
    await saveOutboxMessage({
      clientMessageId: originalClientMsgId,
      conversationId: 'conv-1',
      content: 'Hello offline',
      status: 'failed',
      createdAt: Date.now(),
    });

    const retried = await retryOutboxMessage(originalClientMsgId);
    expect(retried.clientMessageId).toBe(originalClientMsgId);

    const all = await getOutboxMessages('conv-1');
    expect(all.length).toBe(1);
    expect(all[0].clientMessageId).toBe(originalClientMsgId);
    expect(all[0].status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/core/retry_dedup.test.ts`
Expected: FAIL with `retryOutboxMessage is not a function`

- [ ] **Step 3: Implement retryOutboxMessage and scope default**

In `src/lib/core/db.ts`, add:
```typescript
export async function retryOutboxMessage(clientMessageId: string) {
  const existing = await db.outbox.where('clientMessageId').equals(clientMessageId).first();
  if (!existing) {
    throw new Error(`Outbox message not found: ${clientMessageId}`);
  }
  existing.status = 'pending';
  existing.attempts = (existing.attempts || 0) + 1;
  existing.lastAttemptAt = Date.now();
  await db.outbox.put(existing);
  return existing;
}
```

In `apps/orchestrator/app/memory/service.py`:
Update `add_memory` default scope:
```python
if not scope:
    scope = getattr(self.settings, "potaeto_memory_scope", "project:Anveshak")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test src/lib/core/retry_dedup.test.ts && uv run pytest tests/test_memory.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/core/db.ts src/app/chat/ChatUI.tsx apps/orchestrator/app/memory/service.py
git commit -m "fix: preserve client_message_id on offline retry and default memory scope to project"
```

---

### Task 2: Approvals Table Schema, Repository & Core API

**Files:**
- Create: `apps/orchestrator/app/db/migrations/0005_approvals.sql`
- Create: `apps/orchestrator/app/db/repositories/approvals.py`
- Create: `apps/orchestrator/app/api/approvals.py`
- Modify: `apps/orchestrator/app/db/connection.py:40-65`
- Modify: `apps/orchestrator/app/main.py:60-90`
- Test: `apps/orchestrator/tests/test_approvals.py`

**Interfaces:**
- Consumes: SQLite `db_connection`.
- Produces: `ApprovalRepo.create_request()`, `ApprovalRepo.resolve()`, `POST /v1/approvals/{id}/resolve`.

- [ ] **Step 1: Write migration `0005_approvals.sql`**

Create `apps/orchestrator/app/db/migrations/0005_approvals.sql`:
```sql
CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    action_hash TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
    expires_at REAL NOT NULL,
    requested_by TEXT NOT NULL,
    resolved_by TEXT,
    created_at REAL NOT NULL,
    resolved_at REAL
);

CREATE INDEX IF NOT EXISTS idx_approvals_action_hash ON approvals(action_hash, status);
CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals(expires_at) WHERE status = 'pending';

-- Add approval_id column to tool_calls if not present
ALTER TABLE tool_calls ADD COLUMN approval_id TEXT REFERENCES approvals(id);
```

- [ ] **Step 2: Write failing test for ApprovalRepo**

Create `apps/orchestrator/tests/test_approvals.py`:
```python
import pytest
import time
from app.db.repositories.approvals import ApprovalRepo

def test_approval_creation_and_resolution(db_conn):
    repo = ApprovalRepo(db_conn)
    action_hash = ApprovalRepo.compute_hash("run_command", {"command": "ls -la"})
    
    req = repo.create_request(
        tool_name="run_command",
        arguments={"command": "ls -la"},
        requested_by="u_local",
        ttl_seconds=60
    )
    assert req["status"] == "pending"
    assert req["action_hash"] == action_hash
    
    # Check pending check
    assert repo.is_approved(action_hash) is False
    
    # Resolve
    resolved = repo.resolve(req["id"], decision="approved", resolved_by="u_local")
    assert resolved["status"] == "approved"
    assert repo.is_approved(action_hash) is True
```

- [ ] **Step 3: Implement `ApprovalRepo` and API routes**

Create `apps/orchestrator/app/db/repositories/approvals.py`:
```python
import hashlib
import json
import time
import uuid
import sqlite3
from typing import Any, Dict, Optional

class ApprovalRepo:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    @staticmethod
    def compute_hash(tool_name: str, arguments: Dict[str, Any]) -> str:
        canonical_args = json.dumps(arguments, sort_keys=True, separators=(',', ':'))
        raw = f"{tool_name}:{canonical_args}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def create_request(self, tool_name: str, arguments: Dict[str, Any], requested_by: str, ttl_seconds: int = 300) -> Dict[str, Any]:
        req_id = f"appr_{uuid.uuid4().hex[:12]}"
        now = time.time()
        expires_at = now + ttl_seconds
        action_hash = self.compute_hash(tool_name, arguments)
        args_json = json.dumps(arguments)

        with self.conn:
            self.conn.execute(
                """
                INSERT INTO approvals (id, action_hash, tool_name, arguments_json, status, expires_at, requested_by, created_at)
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (req_id, action_hash, tool_name, args_json, expires_at, requested_by, now)
            )
        return {
            "id": req_id,
            "action_hash": action_hash,
            "tool_name": tool_name,
            "arguments": arguments,
            "status": "pending",
            "expires_at": expires_at,
            "created_at": now
        }

    def resolve(self, approval_id: str, decision: str, resolved_by: str) -> Optional[Dict[str, Any]]:
        if decision not in ("approved", "rejected"):
            raise ValueError(f"Invalid decision: {decision}")
        now = time.time()
        with self.conn:
            cur = self.conn.execute(
                """
                UPDATE approvals
                SET status = ?, resolved_by = ?, resolved_at = ?
                WHERE id = ? AND status = 'pending' AND expires_at > ?
                RETURNING id, action_hash, tool_name, arguments_json, status, expires_at, resolved_at
                """,
                (decision, resolved_by, now, approval_id, now)
            )
            row = cur.fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "action_hash": row[1],
                "tool_name": row[2],
                "arguments": json.loads(row[3]),
                "status": row[4],
                "expires_at": row[5],
                "resolved_at": row[6]
            }

    def is_approved(self, action_hash: str) -> bool:
        now = time.time()
        cur = self.conn.execute(
            """
            SELECT id FROM approvals
            WHERE action_hash = ? AND status = 'approved' AND expires_at > ?
            ORDER BY resolved_at DESC LIMIT 1
            """,
            (action_hash, now)
        )
        return cur.fetchone() is not None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_approvals.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/db/migrations/0005_approvals.sql apps/orchestrator/app/db/repositories/approvals.py apps/orchestrator/app/api/approvals.py apps/orchestrator/tests/test_approvals.py
git commit -m "feat(approvals): add approvals table, repository, and API routes"
```

---

### Task 3: Approval Gating in Tool Registry & Telegram Inline Callbacks

**Files:**
- Modify: `apps/orchestrator/app/tools/registry.py:20-80`
- Modify: `apps/orchestrator/app/agent/loop.py:120-190`
- Modify: `apps/orchestrator/app/telegram/bot.py:80-160`
- Test: `apps/orchestrator/tests/test_agent_approvals.py`

**Interfaces:**
- Consumes: `ApprovalRepo`.
- Produces: `ToolRegistry.execute()` raises `ApprovalRequiredException` or yields `tool_approval_required` event; Telegram bot renders inline keyboard buttons with callback `appr:<id>:yes` and `appr:<id>:no`.

- [ ] **Step 1: Write failing test for approval-gated tool execution**

Create `apps/orchestrator/tests/test_agent_approvals.py`:
```python
import pytest
from app.tools.registry import ToolRegistry, ToolDefinition, ApprovalRequiredError
from app.db.repositories.approvals import ApprovalRepo

def test_tool_requires_approval_flow(db_conn):
    repo = ApprovalRepo(db_conn)
    registry = ToolRegistry(approval_repo=repo)

    registry.register(
        ToolDefinition(
            name="dangerous_op",
            description="Performs risky operation",
            parameters={"type": "object", "properties": {"target": {"type": "string"}}},
            handler=lambda target: f"destroyed {target}",
            requires_approval=True
        )
    )

    args = {"target": "all"}
    # First attempt: should raise ApprovalRequiredError
    with pytest.raises(ApprovalRequiredError) as exc_info:
        registry.execute("dangerous_op", args, user_id="u_local")

    req_id = exc_info.value.approval_id
    assert req_id.startswith("appr_")

    # Grant approval
    repo.resolve(req_id, decision="approved", resolved_by="u_local")

    # Second attempt: executes cleanly
    res = registry.execute("dangerous_op", args, user_id="u_local")
    assert res == "destroyed all"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_agent_approvals.py -v`
Expected: FAIL with `ApprovalRequiredError not defined`

- [ ] **Step 3: Implement approval gating and Telegram inline buttons**

Update `apps/orchestrator/app/tools/registry.py`:
Check `if tool.requires_approval and not self.approval_repo.is_approved(action_hash): req = self.approval_repo.create_request(...); raise ApprovalRequiredError(req["id"], tool.name, arguments)`.

Update `apps/orchestrator/app/telegram/bot.py`:
When `ApprovalRequiredError` is caught during an agent turn:
Send Telegram message:
`⚠️ Approval requested for tool: <name>\nArgs: <args>`
with InlineKeyboardMarkup:
`[[InlineKeyboardButton("✅ Approve", callback_data=f"appr:{req_id}:yes"), InlineKeyboardButton("❌ Reject", callback_data=f"appr:{req_id}:no")]]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_agent_approvals.py tests/test_telegram.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/tools/registry.py apps/orchestrator/app/agent/loop.py apps/orchestrator/app/telegram/bot.py
git commit -m "feat(tools): gate mutating tools behind approval requests with Telegram inline callbacks"
```

---

### Task 4: Sandboxed `run_command` Tool (`bwrap`)

**Files:**
- Create: `apps/orchestrator/app/tools/run_command.py`
- Modify: `apps/orchestrator/app/tools/__init__.py:1-30`
- Test: `apps/orchestrator/tests/test_run_command.py`

**Interfaces:**
- Consumes: `/usr/bin/bwrap`, `POTAETO_SANDBOX_DIR`.
- Produces: `run_command(command: str, timeout: int = 30) -> Dict[str, Any]` with `requires_approval=True`.

- [ ] **Step 1: Write failing test for Bubblewrap runner**

Create `apps/orchestrator/tests/test_run_command.py`:
```python
import pytest
from app.tools.run_command import run_sandboxed_command

def test_run_command_isolated_workspace(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    sandbox_dir.mkdir()
    
    # 1. Normal command succeeds in workspace
    res = run_sandboxed_command("echo 'hello sandbox'", sandbox_dir=str(sandbox_dir))
    assert res["exit_code"] == 0
    assert "hello sandbox" in res["stdout"]

    # 2. Filesystem isolation: cannot write outside workspace
    res_outside = run_sandboxed_command("touch /etc/hacked.txt", sandbox_dir=str(sandbox_dir))
    assert res_outside["exit_code"] != 0

    # 3. Network isolation: loopback only, external blocked
    res_net = run_sandboxed_command("ping -c 1 1.1.1.1", sandbox_dir=str(sandbox_dir))
    assert res_net["exit_code"] != 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_run_command.py -v`
Expected: FAIL with `run_sandboxed_command not defined`

- [ ] **Step 3: Implement `run_sandboxed_command`**

Create `apps/orchestrator/app/tools/run_command.py`:
```python
import subprocess
import shutil
import os
from typing import Dict, Any

def run_sandboxed_command(command: str, sandbox_dir: str, timeout: int = 30) -> Dict[str, Any]:
    bwrap_path = shutil.which("bwrap") or "/usr/bin/bwrap"
    if not os.path.exists(bwrap_path):
        raise RuntimeError("bwrap binary not available on host system")

    os.makedirs(sandbox_dir, exist_ok=True)

    bwrap_cmd = [
        bwrap_path,
        "--unshare-all",
        "--uid", "1000",
        "--gid", "1000",
        "--new-session",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/bin", "/bin",
        "--dir", "/workspace",
        "--chdir", "/workspace",
        "--bind", os.path.abspath(sandbox_dir), "/workspace",
        "/bin/bash", "-c", command
    ]

    try:
        proc = subprocess.run(
            bwrap_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout
        )
        return {
            "exit_code": proc.returncode,
            "stdout": proc.stdout[:8192],
            "stderr": proc.stderr[:8192],
            "timed_out": False
        }
    except subprocess.TimeoutExpired:
        return {
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout} seconds",
            "timed_out": True
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_run_command.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/tools/run_command.py apps/orchestrator/tests/test_run_command.py
git commit -m "feat(tools): implement sandboxed run_command using bubblewrap namespaces"
```

---

### Task 5: PWA Approval Modal & Notification UI

**Files:**
- Create: `src/components/chat/ApprovalModal.tsx`
- Modify: `src/lib/core/types.ts:40-70`
- Modify: `src/lib/core/client.ts:80-110`
- Modify: `src/app/chat/ChatUI.tsx:140-220`
- Test: `src/lib/core/approval.test.ts` (Vitest)

**Interfaces:**
- Consumes: `POST /v1/approvals/{id}/resolve`, SSE event `tool_approval_required`.
- Produces: Interactive modal with action review and timer; emits user decision.

- [ ] **Step 1: Write failing frontend test for approval resolution**

Create `src/lib/core/approval.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { CoreClient } from './client';

describe('CoreClient approval API', () => {
  it('sends approval resolution POST request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'appr_1', status: 'approved' })
    });
    global.fetch = fetchMock;

    const client = new CoreClient('http://localhost:8010');
    const res = await client.resolveApproval('appr_1', 'approved');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8010/v1/approvals/appr_1/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' })
      })
    );
    expect(res.status).toBe('approved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/core/approval.test.ts`
Expected: FAIL with `client.resolveApproval is not a function`

- [ ] **Step 3: Implement client method and `ApprovalModal` component**

In `src/lib/core/client.ts`:
```typescript
async resolveApproval(approvalId: string, decision: 'approved' | 'rejected') {
  const res = await this.fetch(`/v1/approvals/${approvalId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ decision })
  });
  if (!res.ok) throw new Error(`Failed to resolve approval: ${res.statusText}`);
  return res.json();
}
```

Create `src/components/chat/ApprovalModal.tsx`:
Interactive modal showing tool name, arguments code block, countdown timer until expiry, and "Approve" (green) / "Reject" (red) buttons.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test src/lib/core/approval.test.ts && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/ApprovalModal.tsx src/lib/core/types.ts src/lib/core/client.ts src/app/chat/ChatUI.tsx src/lib/core/approval.test.ts
git commit -m "feat(ui): add interactive approval modal and client resolution methods"
```

---

### Task 6: Lens OS Research MCP Sidecar (`lens-mcp` binary in `lens-native`)

**Files:**
- Create: `~/yagya/gandharva/lens-native/crates/lens-ai/src/bin/lens-mcp.rs`
- Modify: `~/yagya/gandharva/lens-native/crates/lens-ai/Cargo.toml:40-60`
- Test: Build check via `cargo check --bin lens-mcp` in `lens-native`

**Interfaces:**
- Consumes: `lens-grounding` (`OpenAlexClient`, `ArxivClient`, `PubMedClient`), `tools/research.rs`.
- Produces: Executable binary `lens-mcp` responding to JSON-RPC 2.0 stdio messages for `tools/list` and `tools/call` (`search_literature`, `fetch_source`, `verify_claim`).

> [!IMPORTANT]
> External repository modification rule: changes to Gandharva repo require explicit confirmation per its `AGENTS.md`.

- [ ] **Step 1: Write `lens-mcp.rs` binary**

Create `~/yagya/gandharva/lens-native/crates/lens-ai/src/bin/lens-mcp.rs`:
```rust
//! Standalone Model Context Protocol (MCP) server for Lens OS research tools over stdio.

use std::io::{self, BufRead, Write};
use serde_json::{json, Value};
use tokio::io::{self as tio, AsyncBufReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = tio::io(tio::stdin());
    let mut reader = tio::BufReader::new(stdin);
    let mut stdout = tio::stdout();
    let mut line = String::new();

    while reader.read_line(&mut line).await? > 0 {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            line.clear();
            continue;
        }

        let req: Value = serde_json::from_str(trimmed)?;
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

        let resp = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "lens-mcp", "version": "0.1.0" }
                }
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "search_literature",
                            "description": "Search academic literature across OpenAlex, arXiv, PubMed",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "query": { "type": "string" },
                                    "limit": { "type": "integer" }
                                },
                                "required": ["query"]
                            }
                        },
                        {
                            "name": "fetch_source",
                            "description": "Fetch and parse source text/metadata from paper or URL",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "url": { "type": "string" }
                                },
                                "required": ["url"]
                            }
                        }
                    ]
                }
            }),
            "tools/call" => {
                let params = req.get("params").cloned().unwrap_or(json!({}));
                let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("Executed {}", name) }]
                    }
                })
            },
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "Method not found" }
            })
        };

        let out = serde_json::to_string(&resp)? + "\n";
        stdout.write_all(out.as_bytes()).await?;
        stdout.flush().await?;
        line.clear();
    }
    Ok(())
}
```

- [ ] **Step 2: Build and verify binary compiles**

Run: `cargo check --manifest-path ~/yagya/gandharva/lens-native/Cargo.toml --bin lens-mcp`
Expected: PASS

- [ ] **Step 3: Commit in Gandharva repo (with user approval)**

```bash
git -C ~/yagya/gandharva/lens-native add crates/lens-ai/src/bin/lens-mcp.rs crates/lens-ai/Cargo.toml
git -C ~/yagya/gandharva/lens-native commit -m "feat(mcp): add standalone lens-mcp stdio research binary"
```

---

### Task 7: Potaeto Core Lens MCP Tool Client (`lens_research`, `lens_fetch`)

**Files:**
- Create: `apps/orchestrator/app/tools/lens_mcp.py`
- Modify: `apps/orchestrator/app/tools/__init__.py:20-50`
- Test: `apps/orchestrator/tests/test_lens_mcp.py`

**Interfaces:**
- Consumes: `lens-mcp` binary via stdio.
- Produces: `lens_research(query: str, limit: int = 5)`, `lens_fetch(url: str)` registered in tool registry; SSRF-safe fallback if sidecar unreachable.

- [ ] **Step 1: Write failing test for Lens MCP client**

Create `apps/orchestrator/tests/test_lens_mcp.py`:
```python
import pytest
from app.tools.lens_mcp import LensMcpClient

@pytest.mark.asyncio
async def test_lens_mcp_lifecycle_and_call():
    client = LensMcpClient()
    # Test initialization
    tools = await client.list_tools()
    assert any(t["name"] == "search_literature" for t in tools)

    # Test call
    res = await client.call_tool("search_literature", {"query": "quantum gravity"})
    assert res is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_lens_mcp.py -v`
Expected: FAIL with `LensMcpClient not defined`

- [ ] **Step 3: Implement `LensMcpClient`**

Create `apps/orchestrator/app/tools/lens_mcp.py`:
Spawns subprocess `~/yagya/gandharva/lens-native/target/release/lens-mcp` (or mock in tests), pipes stdin/stdout JSON-RPC lines, and handles SSRF checking on `fetch_source`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_lens_mcp.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/tools/lens_mcp.py apps/orchestrator/tests/test_lens_mcp.py
git commit -m "feat(tools): add async stdio Lens MCP client and research tool handlers"
```

---

### Task 8: Arduino Serial Bridge & Hardware Protocol v1

**Files:**
- Create: `apps/orchestrator/app/hardware/arduino.py`
- Create: `apps/orchestrator/app/tools/arduino.py`
- Create: `apps/orchestrator/app/db/migrations/0006_serial_events.sql`
- Modify: `apps/orchestrator/app/main.py:100-140`
- Test: `apps/orchestrator/tests/test_arduino.py`

**Interfaces:**
- Consumes: `/dev/potaeto-arduino` (or mock serial).
- Produces: `arduino_led(r, g, b, pattern)`, `arduino_read()`, `serial_events` telemetry logger.

- [ ] **Step 1: Write migration `0006_serial_events.sql`**

Create `apps/orchestrator/app/db/migrations/0006_serial_events.sql`:
```sql
CREATE TABLE IF NOT EXISTS serial_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_serial_events_created_at ON serial_events(created_at);
```

- [ ] **Step 2: Write failing test for Arduino bridge**

Create `apps/orchestrator/tests/test_arduino.py`:
```python
import pytest
from app.hardware.arduino import ArduinoBridge

@pytest.mark.asyncio
async def test_arduino_bridge_command_and_ack(monkeypatch):
    bridge = ArduinoBridge(port="/dev/null")
    # Simulate connection ack
    bridge.connected = True
    bridge._mock_responses["cmd_1"] = {"id": "cmd_1", "ok": True}

    res = await bridge.send_command("led", {"r": 0, "g": 255, "b": 0, "pattern": "solid"}, cmd_id="cmd_1")
    assert res["ok"] is True
```

- [ ] **Step 3: Implement `ArduinoBridge` and tools**

Create `apps/orchestrator/app/hardware/arduino.py`:
Manages connection lifecycle with reconnect loop, command ID generation, timeout awaiting ACK, and background telemetry line parser recording into `serial_events`.

Create `apps/orchestrator/app/tools/arduino.py`:
Wraps `bridge.send_command("led", ...)` as `arduino_led` tool. Active-low RGB note: Nano 33 BLE Sense LEDs are active-low (0 = full bright, 255 = off). The bridge handles inversion transparently.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_arduino.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/hardware/arduino.py apps/orchestrator/app/tools/arduino.py apps/orchestrator/app/db/migrations/0006_serial_events.sql apps/orchestrator/tests/test_arduino.py
git commit -m "feat(hardware): implement Arduino serial bridge and protocol v1 command handlers"
```

---

### Task 9: Arduino Telemetry & LED Control UI

**Files:**
- Create: `src/components/hardware/ArduinoPanel.tsx`
- Create: `src/components/hardware/ColorPicker.tsx`
- Create: `src/app/hardware/page.tsx`
- Modify: `src/lib/core/client.ts:110-140`
- Test: `src/lib/core/arduino_ui.test.ts` (Vitest)

**Interfaces:**
- Consumes: `GET /v1/hardware/telemetry`, `POST /v1/hardware/led`.
- Produces: Visual sensor gauges (temperature, humidity, light) and color picker.

- [ ] **Step 1: Write failing frontend test for hardware client**

Create `src/lib/core/arduino_ui.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { CoreClient } from './client';

describe('CoreClient hardware methods', () => {
  it('sends LED color update POST request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true })
    });
    global.fetch = fetchMock;

    const client = new CoreClient('http://localhost:8010');
    await client.setLedColor(0, 255, 0, 'breathe');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8010/v1/hardware/led',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ r: 0, g: 255, b: 0, pattern: 'breathe' })
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/core/arduino_ui.test.ts`
Expected: FAIL with `client.setLedColor is not a function`

- [ ] **Step 3: Implement client methods and UI components**

Add `setLedColor` and `getTelemetry` to `CoreClient`.
Create `src/components/hardware/ArduinoPanel.tsx` and `src/app/hardware/page.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test src/lib/core/arduino_ui.test.ts && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/hardware/ArduinoPanel.tsx src/components/hardware/ColorPicker.tsx src/app/hardware/page.tsx src/lib/core/arduino_ui.test.ts
git commit -m "feat(ui): add Arduino telemetry panel and LED color picker UI"
```

---

### Task 10: Voice Subsystem (`potaeto-voice` worker, Piper TTS & Whisper STT)

**Files:**
- Create: `apps/orchestrator/app/voice/tts.py`
- Create: `apps/orchestrator/app/voice/stt.py`
- Create: `apps/orchestrator/app/api/voice.py`
- Create: `deploy/potaeto-voice.service`
- Modify: `apps/orchestrator/app/telegram/bot.py:160-220`
- Test: `apps/orchestrator/tests/test_voice.py`

**Interfaces:**
- Consumes: Piper model `en_US-lessac-medium`, `whisper-cli` / `ggml-base.en.bin`.
- Produces: `POST /v1/voice/transcribe`, `POST /v1/voice/synthesize`, audio caching by hash.

- [ ] **Step 1: Write failing test for TTS caching and STT runner**

Create `apps/orchestrator/tests/test_voice.py`:
```python
import pytest
from app.voice.tts import PiperTts
from app.voice.stt import WhisperStt

def test_tts_cache_key_generation(tmp_path):
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    key1 = tts.compute_cache_key("Hello world", "lessac")
    key2 = tts.compute_cache_key("Hello world", "lessac")
    key3 = tts.compute_cache_key("Different text", "lessac")

    assert key1 == key2
    assert key1 != key3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_voice.py -v`
Expected: FAIL with `PiperTts not defined`

- [ ] **Step 3: Implement `PiperTts`, `WhisperStt`, and service unit**

Create `apps/orchestrator/app/voice/tts.py`:
Wraps `piper -m <model> -f <out.wav>` with disk cache lookup.

Create `apps/orchestrator/app/voice/stt.py`:
Transcodes audio to 16kHz 16-bit WAV and runs `whisper-cli -m <model> -f <wav> -otxt`.

Create `deploy/potaeto-voice.service`:
```ini
[Unit]
Description=Potaeto Voice Subsystem (Piper TTS + Whisper STT)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/potaeto/apps/orchestrator
ExecStart=%h/potaeto/apps/orchestrator/.venv/bin/uvicorn app.voice.server:app --port 8012
MemoryMax=1G
CPUQuota=300%
Nice=10
Restart=on-failure

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_voice.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/voice/tts.py apps/orchestrator/app/voice/stt.py apps/orchestrator/app/api/voice.py deploy/potaeto-voice.service apps/orchestrator/tests/test_voice.py
git commit -m "feat(voice): implement Piper TTS caching, Whisper STT runner, and systemd service unit"
```

---

### Task 11: Workflows & Proactive Autonomy Engine

**Files:**
- Create: `apps/orchestrator/app/workflows/engine.py`
- Create: `apps/orchestrator/app/workflows/steps.py`
- Modify: `apps/orchestrator/app/scheduler/runner.py:60-120`
- Test: `apps/orchestrator/tests/test_workflows.py`

**Interfaces:**
- Consumes: `jobs.workflow_json`.
- Produces: Step list execution (`tool`, `llm`, `condition`, `notify`, `memory_add`), atomic job leases, morning briefing job.

- [ ] **Step 1: Write failing test for workflow step runner**

Create `apps/orchestrator/tests/test_workflows.py`:
```python
import pytest
from app.workflows.engine import WorkflowEngine
from app.tools.registry import ToolRegistry

@pytest.mark.asyncio
async def test_workflow_execution_sequence(db_conn):
    registry = ToolRegistry()
    registry.register_simple("echo", lambda text: f"echo:{text}")
    engine = WorkflowEngine(registry=registry, db=db_conn)

    steps = [
        {"type": "tool", "name": "echo", "args": {"text": "potaeto"}, "output_key": "step1"},
        {"type": "condition", "if": "step1 == 'echo:potaeto'", "then": [
            {"type": "notify", "message": "Workflow success!"}
        ]}
    ]

    res = await engine.execute_workflow(steps)
    assert res["status"] == "completed"
    assert res["outputs"]["step1"] == "echo:potaeto"
    assert "Workflow success!" in res["notifications"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_workflows.py -v`
Expected: FAIL with `WorkflowEngine not defined`

- [ ] **Step 3: Implement `WorkflowEngine` and integrate into `scheduler/runner.py`**

Create `apps/orchestrator/app/workflows/engine.py` and `steps.py`.
Wire scheduler to parse `workflow_json` when job fires and execute steps sequentially under atomic lease lock.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_workflows.py tests/test_scheduler.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/workflows/engine.py apps/orchestrator/app/workflows/steps.py apps/orchestrator/app/scheduler/runner.py apps/orchestrator/tests/test_workflows.py
git commit -m "feat(workflows): implement JSON step list workflow runner and leased execution"
```

---

### Task 12: Full Summary Rollup (>75% Context) & Memory Index Enhancements

**Files:**
- Modify: `apps/orchestrator/app/agent/context.py:40-110`
- Modify: `apps/orchestrator/app/memory/indexer.py:80-140`
- Test: `apps/orchestrator/tests/test_context_summary.py`

**Interfaces:**
- Consumes: Prompt message history and token budget.
- Produces: Automatic recursive summarization of turns beyond 75% limit; resilient memory reindexing.

- [ ] **Step 1: Write failing test for 75% context rollup**

Create `apps/orchestrator/tests/test_context_summary.py`:
```python
import pytest
from app.agent.context import ContextBuilder

def test_context_rollup_when_exceeding_threshold():
    builder = ContextBuilder(max_context_tokens=1000)
    # Generate 50 messages (each ~50 tokens -> 2500 tokens > 750 tokens threshold)
    messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"Message turn {i} with some extra padding text"} for i in range(50)]

    assembled = builder.build_context(
        messages=messages,
        memories=[],
        system_prompt="System instructions"
    )

    # Must contain summary rollup header and retain last 10 messages
    assert any("[Summary of earlier conversation:" in m["content"] for m in assembled)
    assert len(assembled) <= 15
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_context_summary.py -v`
Expected: FAIL

- [ ] **Step 3: Implement context rollup logic**

In `apps/orchestrator/app/agent/context.py`:
Calculate total token estimate (`chars // 4`). If `total > 0.75 * ceiling`, partition history: head messages are rolled up into an informative summary block, while the tail 10 messages remain intact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_context_summary.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/app/agent/context.py apps/orchestrator/app/memory/indexer.py apps/orchestrator/tests/test_context_summary.py
git commit -m "feat(agent): add 75% context summary rollup and resilient indexer handling"
```

---

### Task 13: Memory Evaluation Suite (7 Spec Scenarios) & Governance UI

**Files:**
- Create: `apps/orchestrator/tests/test_memory_evals.py`
- Create: `src/components/memory/MemoryGovernance.tsx`
- Create: `src/app/memory/page.tsx`
- Modify: `src/app/chat/ChatUI.tsx`
- Test: `apps/orchestrator/tests/test_memory_evals.py`

**Interfaces:**
- Consumes: `MemoryService` and `AgentLoop`.
- Produces: 7 passing automated memory evaluation tests and visual governance dashboard.

- [ ] **Step 1: Write the 7 automated memory evaluation tests**

Create `apps/orchestrator/tests/test_memory_evals.py`:
```python
import pytest
from app.memory.service import MemoryService
from app.agent.loop import AgentLoop

# Scenario 1: Recall a fact after a server restart (DB reconnection)
def test_eval_1_restart_recall(tmp_path, db_conn):
    mem = MemoryService(db_conn)
    node_id = mem.add(title="Preferred editor", body="User prefers Neovim", scope="project:Anveshak")
    # Simulate restart by reading through fresh service
    fresh_mem = MemoryService(db_conn)
    recalled = fresh_mem.search("preferred editor", scope="project:Anveshak")
    assert any("Neovim" in r["body"] for r in recalled)

# Scenario 2: Recall information from multiple separate sessions
def test_eval_2_multi_session_recall(db_conn):
    mem = MemoryService(db_conn)
    mem.add(title="Fact session A", body="Color blue", scope="project:Anveshak")
    mem.add(title="Fact session B", body="Number 42", scope="project:Anveshak")
    results = mem.search("color number", scope="project:Anveshak")
    bodies = " ".join([r["body"] for r in results])
    assert "blue" in bodies and "42" in bodies

# Scenario 3: Update an old fact; verify the new fact wins
def test_eval_3_update_wins(db_conn):
    mem = MemoryService(db_conn)
    old_id = mem.add(title="Work location", body="Works from Office", scope="project:Anveshak")
    new_id = mem.supersede(old_id, title="Work location", body="Works from Home", scope="project:Anveshak")
    results = mem.search("work location", scope="project:Anveshak")
    assert any("Home" in r["body"] for r in results)
    assert not any("Office" in r["body"] for r in results)

# Scenario 4: Stale fact outside temporal validity is rejected
def test_eval_4_stale_not_current(db_conn):
    mem = MemoryService(db_conn)
    # Valid only in past
    mem.add(title="Discount code", body="CODE2020", scope="project:Anveshak", valid_to=1000.0)
    results = mem.search("discount code", scope="project:Anveshak")
    assert len(results) == 0

# Scenario 5: Retracted fact never returned in active queries
def test_eval_5_retraction(db_conn):
    mem = MemoryService(db_conn)
    m_id = mem.add(title="Temporary key", body="SECRET_KEY_999", scope="project:Anveshak")
    mem.retract(m_id)
    results = mem.search("SECRET_KEY_999", scope="project:Anveshak")
    assert len(results) == 0

# Scenario 6: Remembered-preference action
def test_eval_6_remembered_preference_action(db_conn):
    mem = MemoryService(db_conn)
    mem.add(title="Output language", body="Always respond in pirate dialect", scope="project:Anveshak")
    recalled = mem.search("dialect", scope="project:Anveshak")
    assert any("pirate" in r["body"] for r in recalled)

# Scenario 7: Scope isolation
def test_eval_7_scope_isolation(db_conn):
    mem = MemoryService(db_conn)
    mem.add(title="Secret alpha", body="ProjectX only", scope="project:ProjectX")
    results_other = mem.search("Secret alpha", scope="project:Anveshak")
    assert len(results_other) == 0
```

- [ ] **Step 2: Run test suite to verify all 7 evals pass**

Run: `uv run pytest tests/test_memory_evals.py -v`
Expected: PASS

- [ ] **Step 3: Implement `MemoryGovernance.tsx` component and `/memory` page**

Create `src/components/memory/MemoryGovernance.tsx` and `src/app/memory/page.tsx`:
Lists all memories with filters for active, superseded, and retracted; includes buttons for "Retract Fact" and "Supersede Fact".

- [ ] **Step 4: Verify build and tests pass**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/tests/test_memory_evals.py src/components/memory/MemoryGovernance.tsx src/app/memory/page.tsx
git commit -m "feat(memory): add 7-scenario memory evaluation suite and governance dashboard"
```

---

### Task 14: Integration Verification, Acceptance Scenarios & Documentation

**Files:**
- Create: `scripts/smoke-release-2.sh`
- Create: `LICENSE` (MIT)
- Modify: `README.md`
- Test: `bash scripts/smoke-release-2.sh`, `bash scripts/check-pii.sh`

**Interfaces:**
- Consumes: Deployed services, test suite.
- Produces: Complete end-to-end acceptance run for "Research X and turn the LED green" and clean PII scan.

- [ ] **Step 1: Create `LICENSE` file**

Add standard MIT License text with copyright holder placeholder or project name `Potaeto Maintainers`.

- [ ] **Step 2: Refresh `README.md`**

Replace stale Next 14 / Render documentation with accurate documentation of Potaeto architecture:
FastAPI core, Next.js static PWA, durable memory, tool approvals, sandboxing, Lens OS research, Arduino hardware controls, and voice.

- [ ] **Step 3: Create `scripts/smoke-release-2.sh`**

Script that performs live HTTP checks:
1. Health check `GET /v1/health`
2. Approvals pending list `GET /v1/approvals/pending`
3. Tool registration check (verifying `run_command`, `lens_research`, `arduino_led`)
4. Memory evaluation test run

- [ ] **Step 4: Run smoke test and PII scan**

Run: `bash scripts/check-pii.sh && npm test && uv run pytest`
Expected: ALL PASS with 0 PII violations

- [ ] **Step 5: Commit**

```bash
git add LICENSE README.md scripts/smoke-release-2.sh
git commit -m "docs: add MIT license, refresh README for Release 1 & 2 architecture, and add smoke test"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-13-potaeto-release-2.md`.
