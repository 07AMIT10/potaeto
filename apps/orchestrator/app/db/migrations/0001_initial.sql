-- 0001_initial.sql — Release 1 SQLite schema.
--
-- Canonical store for the Potaeto core: identity, the single agent thread,
-- memory, sync, jobs, tool calls, approvals, audit, and telemetry.
-- Text timestamps are SQLite `datetime('now')` (UTC). Rows that participate in
-- sync carry `rev` (optimistic concurrency) and `deleted` (tombstone).

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    passphrase_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT,
    token_hash TEXT NOT NULL,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    characteristics_json TEXT NOT NULL DEFAULT '{}',
    appearance_json TEXT NOT NULL DEFAULT '{}',
    persona_json TEXT NOT NULL DEFAULT '{}',
    skills_json TEXT NOT NULL DEFAULT '[]',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    is_public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rev INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rev INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, entity_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'app',
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rev INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
    summary TEXT NOT NULL DEFAULT '',
    last_message_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_id TEXT,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    source TEXT,
    source_ref TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    scope TEXT NOT NULL DEFAULT 'global',
    status TEXT NOT NULL DEFAULT 'active',
    valid_from TEXT,
    valid_to TEXT,
    supersedes TEXT,
    user_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rev INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status);

CREATE TABLE IF NOT EXISTS memory_edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'related',
    PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS sync_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    server_created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_changes_seq ON sync_changes(seq);

CREATE TABLE IF NOT EXISTS device_sync_state (
    device_id TEXT PRIMARY KEY,
    last_ack_seq INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT
);

CREATE TABLE IF NOT EXISTS client_operations (
    idempotency_key TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_catalog (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    fetched_at TEXT,
    etag TEXT,
    PRIMARY KEY (provider, model_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule TEXT,
    timezone TEXT,
    workflow_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    misfire_policy TEXT NOT NULL DEFAULT 'skip',
    idempotency_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_next_run_enabled ON jobs(next_run, enabled);

CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    output TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    name TEXT NOT NULL,
    arguments_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    finished_at TEXT,
    approval_id TEXT,
    error_code TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    tool_call_id TEXT,
    action_hash TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    approved_at TEXT,
    approved_by TEXT,
    decision TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT,
    kind TEXT NOT NULL,
    subject TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);

CREATE TABLE IF NOT EXISTS provider_usage (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    task_type TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    allowance_json TEXT NOT NULL DEFAULT '{}',
    success INTEGER NOT NULL DEFAULT 1,
    latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS serial_events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audio_cache (
    id TEXT PRIMARY KEY,
    text_hash TEXT NOT NULL,
    voice TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (text_hash, voice)
);

-- Full-text search: external-content FTS5 over messages and memories.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, content='messages', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Initial index rebuild for external-content tables.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

-- Release 1 has exactly one local user and one primary agent.
INSERT INTO users (id, name) VALUES ('u_local', 'Owner') ON CONFLICT DO NOTHING;
INSERT INTO entities (id, user_id, name, slug, persona_json, attributes_json)
VALUES ('e_potaeto', 'u_local', 'Potaeto', 'potaeto', '{}', '{}') ON CONFLICT DO NOTHING;
