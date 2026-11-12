-- 0004_telegram_updates.sql — durable Telegram update bookkeeping.
--
-- Telegram delivers updates at-least-once: a long poll whose response is lost
-- is retried with the same update_id. Persisting the id before processing (and
-- marking `processed_at` only after the reply is durable) lets the bot dedupe
-- retries and keep an honest acknowledgement offset across restarts.
--
-- The bot token is never stored here; `chat_id` is the only identifier kept.

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id INTEGER PRIMARY KEY,
    chat_id INTEGER,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
);
