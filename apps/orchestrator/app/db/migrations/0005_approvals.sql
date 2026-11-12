-- 0005_approvals.sql — approvals table & tool_calls lifecycle columns.
--
-- Exact cryptographic, expiring, status-gated tool approvals.

DROP TABLE IF EXISTS approvals;

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
