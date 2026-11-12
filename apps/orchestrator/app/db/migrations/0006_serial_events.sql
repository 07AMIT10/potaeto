-- 0006_serial_events.sql — bounded hardware telemetry and event log.
--
-- Records serial telemetry frames from the Arduino Nano 33 BLE Sense Rev2.
-- Replaces the unused Release 1 stub table with the Protocol v1 event schema.
-- Pruned periodically to retain recent detailed history without unbounded
-- growth.

DROP TABLE IF EXISTS serial_events;

CREATE TABLE IF NOT EXISTS serial_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_serial_events_created_at ON serial_events(created_at);
