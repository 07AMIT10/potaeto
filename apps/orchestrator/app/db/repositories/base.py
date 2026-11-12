"""Shared helpers for the SQLite repositories."""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any, TypeVar

from app.db.connection import WRITE_LOCK

T = TypeVar("T")

# Lower-case Crockford base32, the alphabet used by ULIDs.
_CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"


def new_id(prefix: str) -> str:
    """Return a time-ordered id such as ``m_01j9z4b7kq...``.

    The suffix is a ULID (48-bit millisecond timestamp + 80 random bits), so ids
    sort by creation time while staying collision resistant.
    """
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    suffix = "".join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))
    return f"{prefix}_{suffix}"


def dump_json(value: Any) -> str:
    """Serialize a value for a `*_json` column."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def load_json(value: Any) -> Any:
    """Parse a `*_json` column, tolerating already-decoded values."""
    if value is None or isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def from_row(model: type[T], row: sqlite3.Row, json_fields: Iterable[str] = ()) -> T:
    """Build a dataclass from a row, decoding the listed JSON columns."""
    data = dict(row)
    for name in json_fields:
        if name in data:
            data[name] = load_json(data[name])
    return model(**data)


def fts_query(text: str) -> str:
    """Turn free text into a safe FTS5 MATCH expression (implicit AND)."""
    tokens = [token.replace('"', '""') for token in text.split()]
    return " ".join(f'"{token}"' for token in tokens)


#: Function words that add no retrieval signal. Leaving them in an OR query
#: makes every memory match and pushes relevant facts down the BM25 ranking.
FTS_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "did",
        "do",
        "does",
        "for",
        "from",
        "how",
        "i",
        "in",
        "is",
        "it",
        "me",
        "my",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "was",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "with",
        "you",
        "your",
    }
)


def _fts_token(raw: str) -> str:
    """Normalize one query token to FTS5 letters/digits (dots become space)."""
    return "".join(ch if ch.isalnum() or ch == "_" else " " for ch in raw).strip()


def fts_any_query(text: str) -> str:
    """Build an OR/prefix FTS5 expression so any meaningful token can match.

    FTS5's default tokenizer has no stemming, so ``like`` would not match
    ``likes``. A prefix query (``like*``) restores that without a custom
    tokenizer. Function words are dropped; an empty result means the caller
    should fall back to recency rather than run an unbounded match.
    """
    tokens: list[str] = []
    for raw in text.split():
        for part in _fts_token(raw).split():
            token = part.lower()
            if len(token) < 2 or token in FTS_STOPWORDS or token in tokens:
                continue
            tokens.append(token)
    return " OR ".join(f"{token}*" for token in tokens)


def fetch_one(
    conn: sqlite3.Connection, sql: str, params: Sequence[Any] = ()
) -> sqlite3.Row | None:
    """Execute + fetch under the lock; a cursor must not outlive it.

    Python's sqlite3 connection resets cached statements when another thread
    executes, so the safe unit is "execute and consume", not just "execute".
    """
    with WRITE_LOCK:
        return conn.execute(sql, params).fetchone()


def fetch_all(
    conn: sqlite3.Connection, sql: str, params: Sequence[Any] = ()
) -> list[sqlite3.Row]:
    """Execute + fetchall under the lock (see :func:`fetch_one`)."""
    with WRITE_LOCK:
        return conn.execute(sql, params).fetchall()


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Run a write block under the process-wide lock.

    Replaces bare ``with conn:`` blocks, which commit the shared connection and
    can therefore commit another thread's in-flight transaction. Nested blocks
    join the outer transaction instead of committing it halfway through.
    """
    with WRITE_LOCK:
        if conn.in_transaction:
            yield
            return
        try:
            yield
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


class BaseRepo:
    """Small wrapper around a connection; subclasses own one table."""

    table: str = ""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def _one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        return fetch_one(self.conn, sql, params)

    def _all(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        return fetch_all(self.conn, sql, params)

    def _scalar(self, sql: str, params: Sequence[Any] = ()) -> Any:
        row = self._one(sql, params)
        return None if row is None else row[0]

    @staticmethod
    def require(value: T | None, what: str, identifier: Any) -> T:
        if value is None:
            raise LookupError(f"{what} {identifier!r} not found")
        return value

    def _update(
        self,
        row_id: str,
        values: dict[str, Any],
        allowed: Sequence[str],
        *,
        bump_rev: bool = True,
        touch: bool = True,
    ) -> None:
        """Apply whitelisted column updates to a single row."""
        assignments: list[str] = []
        params: list[Any] = []
        for column, value in values.items():
            if column not in allowed:
                raise ValueError(f"{self.table}.{column} is not updatable")
            assignments.append(f"{column} = ?")
            params.append(dump_json(value) if column.endswith("_json") else value)
        if not assignments:
            return
        if touch:
            assignments.append("updated_at = datetime('now')")
        if bump_rev:
            assignments.append("rev = rev + 1")
        params.append(row_id)
        with self.write_transaction():
            self.conn.execute(
                f"UPDATE {self.table} SET {', '.join(assignments)} WHERE id = ?",
                params,
            )

    @contextmanager
    def write_transaction(self) -> Iterator[None]:
        """Run a block in an immediate write transaction.

        `BEGIN IMMEDIATE` takes the write lock up front, so read-modify-write
        sequences (such as allocating the next message `seq`) cannot deadlock by
        upgrading a read snapshot. The busier path waits up to `busy_timeout`.
        The process lock is held for the whole transaction, so two threads can
        never interleave BEGIN/COMMIT on the shared connection.
        """
        with WRITE_LOCK:
            if self.conn.in_transaction:
                yield
                return
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.conn.commit()
            except BaseException:
                self.conn.rollback()
                raise

    @staticmethod
    def _filter_clause(filters: dict[str, Any], *, include_deleted: bool) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        for column, value in filters.items():
            if value is None:
                continue
            clauses.append(f"{column} = ?")
            params.append(value)
        if not include_deleted:
            clauses.append("deleted = 0")
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        return where, params
