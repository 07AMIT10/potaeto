"""Governed long-term memory: provenance, validity, supersession, retraction.

`agent-memory` markdown is canonical for *content*; SQLite is canonical for
*governance*. Every memory carries where it came from, how confident it is,
when it is valid, and whether the user confirmed it. Retrieval only ever
returns active memories inside the requested scope, so a stale, superseded, or
retracted fact cannot influence an answer.

Web and tool output are candidates, never personal facts: :class:`MemoryService`
caps their confidence and never promotes them to ``user_confirmed``.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from app.audit import audit_safely
from app.db.repositories.base import fetch_all, from_row, fts_any_query
from app.db.repositories.memories import Memory, MemoryRepo

# Sources whose content the agent merely *observed* rather than the user stating.
UNTRUSTED_SOURCES = frozenset(
    {"web", "tool", "document", "lens", "external", "telegram", "email"}
)

# Untrusted facts may be useful, but they are candidates: keep them below the
# confidence of a confirmed user fact until the user confirms them.
CANDIDATE_CONFIDENCE_CAP = 0.6

ACTIVE = "active"
SUPERSEDED = "superseded"
RETRACTED = "retracted"


def utc_now() -> str:
    """Return the timestamp format used by the SQLite schema."""
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")


def _clamp_confidence(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


class MemoryService:
    """Read/write governed memories for one user."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.repo = MemoryRepo(conn)

    # -- writes ---------------------------------------------------------

    def add(
        self,
        user_id: str = "u1",
        entity_id: str | None = None,
        kind: str = "fact",
        content: str | None = None,
        source: str = "user",
        source_ref: str | None = None,
        confidence: float = 0.9,
        scope: str = "global",
        sensitivity: str = "normal",
        user_confirmed: bool = True,
        *,
        body: str | None = None,
        title: str | None = None,
        valid_from: str | None = None,
        valid_to: str | float | None = None,
    ) -> Memory:
        """Store a new active memory.

        ``source`` is mandatory: a fact with no provenance is not memory, it is
        a rumour. Untrusted sources are capped at candidate confidence unless
        the user explicitly confirmed the fact.
        """
        if content is None:
            if body is not None:
                content = f"{title}\n\n{body}".strip() if title else body.strip()
            elif title is not None:
                content = title.strip()
        source = (source or "").strip()
        content = (content or "").strip()
        if not source:
            raise ValueError("memory writes require a source")
        if not content:
            raise ValueError("memory content must not be empty")

        if isinstance(valid_to, (int, float)):
            valid_to = datetime.fromtimestamp(valid_to, UTC).strftime("%Y-%m-%d %H:%M:%S")

        confidence = _clamp_confidence(confidence)
        if not user_confirmed and source.lower() in UNTRUSTED_SOURCES:
            confidence = min(confidence, CANDIDATE_CONFIDENCE_CAP)

        memory = self.repo.create(
            user_id=user_id,
            entity_id=entity_id,
            kind=kind,
            content=content,
            source=source,
            source_ref=source_ref,
            confidence=confidence,
            sensitivity=sensitivity,
            scope=scope,
            user_confirmed=user_confirmed,
            valid_from=valid_from,
            valid_to=valid_to,
        )
        self._audit(
            user_id,
            "memory_add",
            memory.id,
            {
                "kind": kind,
                "source": source,
                "scope": scope,
                "user_confirmed": bool(user_confirmed),
            },
        )
        return memory

    def update(
        self,
        memory_id: str | Memory,
        content: str | None = None,
        confidence: float | None = None,
    ) -> Memory:
        """Correct a memory in place; the corrected fact wins on retrieval."""
        target_id = getattr(memory_id, "id", str(memory_id))
        self.recall(target_id)  # raises LookupError when missing
        fields: dict[str, object] = {}
        if content is not None:
            content = content.strip()
            if not content:
                raise ValueError("memory content must not be empty")
            fields["content"] = content
        if confidence is not None:
            fields["confidence"] = _clamp_confidence(confidence)
        if not fields:
            return self.recall(target_id)
        updated = self.repo.update(target_id, **fields)
        self._audit(
            updated.user_id,
            "memory_update",
            target_id,
            {"fields": sorted(fields)},
        )
        return updated

    def supersede(
        self,
        old_id: str | Memory,
        new_id: str | Memory | None = None,
        *,
        title: str | None = None,
        body: str | None = None,
        content: str | None = None,
        scope: str | None = None,
        **kwargs: Any,
    ) -> str:
        """Replace ``old_id`` with ``new_id`` or new content.

        The old memory becomes ``superseded`` and stops being valid now, so it
        disappears from retrieval while remaining available for audit.
        """
        old_id_str = getattr(old_id, "id", str(old_id))
        old = self.recall(old_id_str)
        if body is not None or content is not None or title is not None:
            new_scope = scope or old.scope
            new_mem = self.add(
                user_id=old.user_id,
                entity_id=old.entity_id,
                kind=old.kind,
                content=content,
                body=body,
                title=title,
                scope=new_scope,
                source=old.source or "user",
                source_ref=old.source_ref,
                confidence=old.confidence,
                sensitivity=old.sensitivity,
                user_confirmed=True,
                **kwargs,
            )
            self._apply_supersede(old_id_str, new_mem.id)
            return new_mem.id

        if new_id is None:
            raise ValueError("new_id or new content is required to supersede")
        new_id_str = getattr(new_id, "id", str(new_id))
        self._apply_supersede(old_id_str, new_id_str)
        return new_id_str

    def _apply_supersede(self, old_id: str, new_id: str) -> None:
        if old_id == new_id:
            raise ValueError("a memory cannot supersede itself")
        old = self.recall(old_id)
        new = self.recall(new_id)
        if old.status != ACTIVE:
            raise ValueError(f"memory {old_id!r} is not active")
        if new.status != ACTIVE:
            raise ValueError(f"memory {new_id!r} is not active")
        with self.repo.write_transaction():
            self.repo.update(old_id, status=SUPERSEDED, valid_to=utc_now())
            self.repo.update(new_id, supersedes=old_id)
            self._audit(
                old.user_id,
                "memory_supersede",
                old_id,
                {"superseded_by": new_id},
            )

    def retract(self, memory_id: str | Memory) -> None:
        """Revoke a memory; it disappears from retrieval and prompts."""
        target_id = getattr(memory_id, "id", str(memory_id))
        memory = self.recall(target_id)
        self.repo.update(target_id, status=RETRACTED, valid_to=utc_now())
        self._audit(
            memory.user_id,
            "memory_retract",
            target_id,
            {"previous_status": memory.status},
        )

    def confirm(self, memory_id: str | Memory) -> Memory:
        """Mark a memory confirmed by the user, promoting it from candidate."""
        target_id = getattr(memory_id, "id", str(memory_id))
        mem = self.recall(target_id)
        updated = self.repo.update(target_id, user_confirmed=1)
        self._audit(
            updated.user_id,
            "memory_confirm",
            target_id,
            {"previous_confirmed": mem.user_confirmed},
        )
        return updated

    def _audit(
        self,
        actor: str | None,
        kind: str,
        subject: str,
        detail: dict[str, object],
    ) -> None:
        """Record a memory mutation; a broken audit trail must not lose data."""
        audit_safely(self.conn, actor, kind, subject, detail)

    # -- reads ----------------------------------------------------------

    def search(
        self,
        query_or_user_id: str,
        query: str | None = None,
        limit: int = 10,
        *,
        scope: str = "global",
        user_id: str | None = None,
    ) -> list[Memory]:
        """Return active, currently-valid memories relevant to ``query``.

        The FTS query is an OR of meaningful prefixes, so "what do I like?"
        finds "Alex likes tea" instead of matching nothing. When no token
        matches (or the query has only stopwords), fall back to the most recent
        active memories in scope so retrieval still gives the context builder
        something useful.

        ``scope`` defaults to ``global``, which only exposes global memories.
        Passing a project scope widens the result to ``global`` + that project,
        so project-private facts never leak into an unrelated context.
        """
        if query is None:
            actual_query = query_or_user_id
            actual_user_id = user_id or "u1"
        else:
            actual_user_id = query_or_user_id
            actual_query = query

        scopes = ["global"] if scope == "global" else ["global", scope]
        placeholders = ", ".join("?" for _ in scopes)
        base_filter = (
            "m.user_id = ? AND m.deleted = 0 AND m.status = ? "
            "AND (m.valid_to IS NULL OR datetime(m.valid_to) > datetime('now')) "
            f"AND m.scope IN ({placeholders})"
        )

        match = fts_any_query(actual_query)
        if match:
            rows = fetch_all(
                self.conn,
                f"""
                SELECT m.* FROM memories_fts f
                JOIN memories m ON m.rowid = f.rowid
                WHERE memories_fts MATCH ?
                  AND {base_filter}
                ORDER BY bm25(memories_fts), m.confidence DESC
                LIMIT ?
                """,
                (match, actual_user_id, ACTIVE, *scopes, limit),
            )
            if rows:
                return [from_row(Memory, row) for row in rows]

        rows = fetch_all(
            self.conn,
            f"""
            SELECT m.* FROM memories m
            WHERE {base_filter}
            ORDER BY m.updated_at DESC, m.confidence DESC, m.rowid DESC
            LIMIT ?
            """,
            (actual_user_id, ACTIVE, *scopes, limit),
        )
        return [from_row(Memory, row) for row in rows]

    def recall(self, memory_id: str | Memory) -> Memory:
        """Return one memory by id, including superseded/retracted rows."""
        target_id = getattr(memory_id, "id", str(memory_id))
        return self.repo.require(self.repo.get(target_id), "memory", target_id)
