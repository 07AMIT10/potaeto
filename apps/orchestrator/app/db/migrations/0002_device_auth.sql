-- 0002_device_auth.sql — pairing codes and device revocation.
--
-- Pairing codes are short-lived, single-use bearer codes exchanged for a device
-- token. Only the SHA-256 hash of a code is stored (`code_hash`), matching the
-- device token policy: no plaintext credentials at rest.
--
-- `expires_at` is a Unix epoch second so expiry checks do not depend on SQLite
-- timestamp text formatting; `created_at` stays a UTC datetime for auditability.

ALTER TABLE devices ADD COLUMN revoked_at TEXT;

CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires ON pairing_codes(expires_at);
