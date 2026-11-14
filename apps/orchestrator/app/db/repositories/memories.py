"""Long-term memory repository backed by `memories` + `memories_fts` + `vec_memories`."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import (
    BaseRepo,
    from_row,
    fts_any_query,
    fts_query,
    new_id,
    transaction,
)

logger = logging.getLogger(__name__)


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
    rrf_score: float | None = None

    def __getitem__(self, item: str) -> Any:
        if item == "body":
            return self.content
        if hasattr(self, item):
            return getattr(self, item)
        raise KeyError(item)

    @property
    def body(self) -> str:
        return self.content


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

    def index_vector(self, rowid: int, content: str) -> None:
        """Embed and index memory content into vec_memories."""
        if not content:
            return
        try:
            from app.memory.embeddings import generate_embedding, serialize_float32

            vec = generate_embedding(content)
            data = serialize_float32(vec)
            self.conn.execute("DELETE FROM vec_memories WHERE rowid = ?", (rowid,))
            self.conn.execute(
                "INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)",
                (rowid, data),
            )
        except Exception as exc:
            logger.debug("Vector indexing skipped for rowid %s: %s", rowid, exc)

    def backfill_vectors(self) -> int:
        """Backfill vector embeddings for any un-indexed memories."""
        has_vec = self._one(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memories'"
        )
        if not has_vec:
            return 0
        rows = self._all(
            """
            SELECT m.rowid, m.content
            FROM memories m
            LEFT JOIN vec_memories v ON v.rowid = m.rowid
            WHERE m.deleted = 0 AND v.rowid IS NULL AND m.content != ''
            """
        )
        count = 0
        for row in rows:
            self.index_vector(row["rowid"], row["content"])
            count += 1
        return count

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
            cur = self.conn.execute(
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
            rowid = cur.lastrowid
            if rowid:
                self.index_vector(rowid, content)
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
        row = self._one("SELECT rowid, content, deleted FROM memories WHERE id = ?", (memory_id,))
        if row is not None:
            if fields.get("deleted") == 1:
                try:
                    self.conn.execute("DELETE FROM vec_memories WHERE rowid = ?", (row["rowid"],))
                except Exception:
                    pass
            elif "content" in fields or fields.get("deleted") == 0:
                self.index_vector(row["rowid"], row["content"])
        return self.require(self.get(memory_id, include_deleted=True), "memory", memory_id)

    def delete(self, memory_id: str) -> Memory:
        """Soft-delete (tombstone); searches filter `deleted` rows out."""
        mem = self.update(memory_id, deleted=1)
        row = self._one("SELECT rowid FROM memories WHERE id = ?", (memory_id,))
        if row is not None:
            try:
                self.conn.execute("DELETE FROM vec_memories WHERE rowid = ?", (row["rowid"],))
            except Exception:
                pass
        return mem

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

    def hybrid_search(
        self,
        query: str,
        top_k: int = 5,
        rrf_k: int = 60,
        *,
        user_id: str | None = None,
        entity_id: str | None = None,
        scope: str | None = None,
        status: str = "active",
    ) -> list[Memory]:
        """Hybrid vector (KNN) and lexical (BM25) search with Reciprocal Rank Fusion.

        Uses a SQL CTE combining vec_memories and fts_memories via FULL OUTER JOIN
        with RRF scoring: 1.0 / (rrf_k + rank_vec) + 1.0 / (rrf_k + rank_fts).
        """
        query_str = query.strip()
        if not query_str:
            return []

        try:
            from app.memory.embeddings import generate_embedding, serialize_float32

            query_vec = serialize_float32(generate_embedding(query_str))
        except Exception as exc:
            logger.debug("Failed to prepare vector embedding for hybrid search: %s", exc)
            return self.search(query, user_id=user_id, entity_id=entity_id, limit=top_k)

        has_vec = self._one(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memories'"
        )
        if not has_vec:
            return self.search(query, user_id=user_id, entity_id=entity_id, limit=top_k)

        fts_table = "fts_memories"
        has_fts = self._one(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='fts_memories'"
        )
        if not has_fts:
            fts_table = "memories_fts"

        match = fts_any_query(query_str) or fts_query(query_str)
        k_candidates = max(top_k * 4, 25)

        filter_clauses = ["m.deleted = 0"]
        filter_params: list[Any] = []
        if status is not None:
            filter_clauses.append("m.status = ?")
            filter_params.append(status)
        if user_id is not None:
            filter_clauses.append("m.user_id = ?")
            filter_params.append(user_id)
        if entity_id is not None:
            filter_clauses.append("m.entity_id = ?")
            filter_params.append(entity_id)
        if scope is not None:
            if scope == "global":
                filter_clauses.append("m.scope = 'global'")
            else:
                filter_clauses.append("m.scope IN ('global', ?)")
                filter_params.append(scope)

        where_filter = f"WHERE {' AND '.join(filter_clauses)}"

        if match:
            sql = f"""
            WITH vec_matches AS (
                SELECT rowid, row_number() OVER (ORDER BY distance ASC) AS rank_vec
                FROM vec_memories
                WHERE embedding MATCH ? AND k = ?
            ),
            fts_matches AS (
                SELECT rowid, row_number() OVER (ORDER BY bm25({fts_table}) ASC) AS rank_fts
                FROM {fts_table}
                WHERE {fts_table} MATCH ?
                LIMIT ?
            ),
            fused AS (
                SELECT
                    coalesce(v.rowid, f.rowid) AS rowid,
                    coalesce(1.0 / (? + v.rank_vec), 0.0) + coalesce(1.0 / (? + f.rank_fts), 0.0) AS rrf_score
                FROM vec_matches v
                FULL OUTER JOIN fts_matches f ON v.rowid = f.rowid
            )
            SELECT m.*, fused.rrf_score
            FROM fused
            JOIN memories m ON m.rowid = fused.rowid
            {where_filter}
            ORDER BY fused.rrf_score DESC
            LIMIT ?
            """
            params = [
                query_vec,
                k_candidates,
                match,
                k_candidates,
                rrf_k,
                rrf_k,
                *filter_params,
                top_k,
            ]
        else:
            sql = f"""
            WITH vec_matches AS (
                SELECT rowid, row_number() OVER (ORDER BY distance ASC) AS rank_vec
                FROM vec_memories
                WHERE embedding MATCH ? AND k = ?
            ),
            fts_matches AS (
                SELECT CAST(NULL AS INTEGER) AS rowid, CAST(1 AS INTEGER) AS rank_fts
                WHERE 0
            ),
            fused AS (
                SELECT
                    coalesce(v.rowid, f.rowid) AS rowid,
                    coalesce(1.0 / (? + v.rank_vec), 0.0) AS rrf_score
                FROM vec_matches v
                FULL OUTER JOIN fts_matches f ON v.rowid = f.rowid
            )
            SELECT m.*, fused.rrf_score
            FROM fused
            JOIN memories m ON m.rowid = fused.rowid
            {where_filter}
            ORDER BY fused.rrf_score DESC
            LIMIT ?
            """
            params = [
                query_vec,
                k_candidates,
                rrf_k,
                *filter_params,
                top_k,
            ]

        try:
            rows = self._all(sql, params)
            return [self._to_model(row) for row in rows]
        except Exception as exc:
            logger.warning("Hybrid search query error, falling back to FTS: %s", exc)
            return self.search(query, user_id=user_id, entity_id=entity_id, limit=top_k)
