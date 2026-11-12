"""Long-term memory repository backed by `memories` + `memories_fts`."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, from_row, fts_query, new_id, transaction


@dataclass(frozen=True)
class Memory:
    id: str
    user_id: str
    entity_id: str | None
    kind: str
    content: str
    source: str | None
    source_ref: str | None
    confidence: float
    sensitivity: str
    scope: str
    status: str
    valid_from: str | None
    valid_to: str | None
    supersedes: str | None
    user_confirmed: int
    created_at: str
    updated_at: str
    rev: int
    deleted: int
    content_hash: str | None = None


class MemoryRepo(BaseRepo):
    table = "memories"
    _UPDATABLE = (
        "entity_id",
        "kind",
        "content",
        "source",
        "source_ref",
        "confidence",
        "sensitivity",
        "scope",
        "status",
        "valid_from",
        "valid_to",
        "supersedes",
        "user_confirmed",
        "deleted",
        "content_hash",
    )

    def _to_model(self, row) -> Memory:
        return from_row(Memory, row)

    def create(
        self,
        user_id: str,
        content: str,
        *,
        entity_id: str | None = None,
        kind: str = "fact",
        source: str | None = None,
        source_ref: str | None = None,
        confidence: float = 0.5,
        sensitivity: str = "normal",
        scope: str = "global",
        status: str = "active",
        valid_from: str | None = None,
        valid_to: str | None = None,
        supersedes: str | None = None,
        user_confirmed: bool = False,
        content_hash: str | None = None,
        memory_id: str | None = None,
    ) -> Memory:
        identifier = memory_id or new_id("mem")
        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO memories (
                    id, user_id, entity_id, kind, content, source, source_ref,
                    confidence, sensitivity, scope, status, valid_from, valid_to,
                    supersedes, user_confirmed, content_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    user_id,
                    entity_id,
                    kind,
                    content,
                    source,
                    source_ref,
                    confidence,
                    sensitivity,
                    scope,
                    status,
                    valid_from,
                    valid_to,
                    supersedes,
                    1 if user_confirmed else 0,
                    content_hash,
                ),
            )
        return self.require(self.get(identifier), "memory", identifier)

    def get(self, memory_id: str, *, include_deleted: bool = False) -> Memory | None:
        row = self._one("SELECT * FROM memories WHERE id = ?", (memory_id,))
        if row is None or (row["deleted"] and not include_deleted):
            return None
        return self._to_model(row)

    def list(
        self,
        *,
        user_id: str | None = None,
        entity_id: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        include_deleted: bool = False,
        limit: int | None = None,
    ) -> list[Memory]:
        where, params = self._filter_clause(
            {
                "user_id": user_id,
                "entity_id": entity_id,
                "kind": kind,
                "status": status,
            },
            include_deleted=include_deleted,
        )
        sql = f"SELECT * FROM memories{where} ORDER BY created_at DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return [self._to_model(row) for row in self._all(sql, params)]

    def update(self, memory_id: str, **fields: Any) -> Memory:
        self._update(memory_id, fields, self._UPDATABLE)
        return self.require(self.get(memory_id, include_deleted=True), "memory", memory_id)

    def delete(self, memory_id: str) -> Memory:
        """Soft-delete (tombstone); searches filter `deleted` rows out.

        The FTS row is only removed by the trigger on a hard DELETE, so the
        index keeps the text but no query returns a tombstoned memory.
        """
        return self.update(memory_id, deleted=1)

    def search(
        self,
        query: str,
        *,
        user_id: str | None = None,
        entity_id: str | None = None,
        limit: int = 10,
    ) -> list[Memory]:
        """Full-text memory search ordered by BM25 relevance."""
        match = fts_query(query)
        if not match:
            return []
        clauses = ["memories_fts MATCH ?", "m.deleted = 0"]
        params: list[Any] = [match]
        if user_id is not None:
            clauses.append("m.user_id = ?")
            params.append(user_id)
        if entity_id is not None:
            clauses.append("m.entity_id = ?")
            params.append(entity_id)
        params.append(limit)
        rows = self._all(
            f"""
            SELECT m.* FROM memories_fts f
            JOIN memories m ON m.rowid = f.rowid
            WHERE {' AND '.join(clauses)}
            ORDER BY bm25(memories_fts) LIMIT ?
            """,
            params,
        )
        return [self._to_model(row) for row in rows]
