"""SQLite connection setup and migration runner."""

from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path

from app.db.migrations import discover_migrations

logger = logging.getLogger(__name__)

#: Process-wide write lock guarding the single shared connection.
#:
#: `check_same_thread=False` lets FastAPI's threadpool and the event loop use
#: one ``sqlite3.Connection``. Without a lock, one thread can call ``BEGIN`` or
#: ``COMMIT`` while another is mid-transaction: writes join the wrong
#: transaction, commits land early, or SQLite raises "cannot start a
#: transaction within a transaction". Every write path acquires this reentrant
#: lock (``BaseRepo.write_transaction`` and the ``transaction`` helper), and
#: ``LockedConnection``/the fetch helpers also hold it for reads, because the
#: Python sqlite3 module resets cached statements when another thread executes.
WRITE_LOCK = threading.RLock()

SCHEMA_VERSION_TABLE = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)
"""


class LockedConnection(sqlite3.Connection):
    """A shared connection whose statement entry points take the write lock.

    Python's sqlite3 connection is not safe for two threads to call
    ``execute`` concurrently even with ``check_same_thread=False`` (the module
    resets cached statements), and its transaction state is connection-wide.
    Wrapping the statement methods means reads and writes are serialized
    without every caller remembering to lock. The lock is reentrant, so a
    ``write_transaction`` holding it can keep calling ``execute``.
    """

    def execute(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        with WRITE_LOCK:
            return super().execute(*args, **kwargs)

    def executemany(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        with WRITE_LOCK:
            return super().executemany(*args, **kwargs)

    def executescript(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        with WRITE_LOCK:
            return super().executescript(*args, **kwargs)


def load_vec_extension(conn: sqlite3.Connection) -> bool:
    """Load sqlite-vec extension if available. Returns True if loaded."""
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        try:
            sqlite_vec.load(conn)
            return True
        finally:
            conn.enable_load_extension(False)
    except Exception as exc:
        logger.debug("sqlite-vec extension not loaded: %s", exc)
        return False


def _backfill_memory_vectors(conn: sqlite3.Connection) -> None:
    """Index vectors for any memory rows missing from vec_memories."""
    try:
        has_vec = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memories'"
        ).fetchone()
        if not has_vec:
            return
        rows = conn.execute(
            """
            SELECT m.rowid, m.content
            FROM memories m
            LEFT JOIN vec_memories v ON v.rowid = m.rowid
            WHERE m.deleted = 0 AND v.rowid IS NULL AND m.content != ''
            """
        ).fetchall()
        if not rows:
            return
        from app.memory.embeddings import generate_embedding, serialize_float32

        with WRITE_LOCK:
            for row in rows:
                rowid, content = row[0], row[1]
                vec = generate_embedding(content)
                conn.execute(
                    "INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)",
                    (rowid, serialize_float32(vec)),
                )
            conn.commit()
    except Exception as exc:
        logger.debug("Vector backfill skipped: %s", exc)


def connect_db(path: str | Path) -> sqlite3.Connection:
    """Open a connection configured with the canonical pragmas.

    `check_same_thread=False` is required because FastAPI request handlers and
    background workers share the connection. Cross-thread writes are serialized
    by :data:`WRITE_LOCK` (not just SQLite's own locking), because a shared
    connection's transaction state is global: an unlocked second writer can
    commit the first writer's in-flight transaction.
    """
    if str(path) != ":memory:":
        path = Path(path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, factory=LockedConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    load_vec_extension(conn)
    return conn


def run_migrations(conn: sqlite3.Connection) -> None:
    """Apply every migration that has not been recorded in `schema_version`.

    Each migration and its version row are applied atomically; calling this
    repeatedly is a no-op for already-applied versions.
    """
    load_vec_extension(conn)
    conn.execute(SCHEMA_VERSION_TABLE)
    conn.commit()

    applied = {row[0] for row in conn.execute("SELECT version FROM schema_version")}
    for migration in discover_migrations():
        if migration.version in applied:
            continue
        script = (
            "BEGIN;\n"
            f"{migration.sql}\n"
            f"INSERT INTO schema_version (version) VALUES ({migration.version});\n"
            "COMMIT;\n"
        )
        try:
            conn.executescript(script)
        except Exception:
            conn.rollback()
            raise

    _backfill_memory_vectors(conn)
