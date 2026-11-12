"""Catalog cache: in-memory TTL with optional SQLite ``model_catalog`` backing."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict
from datetime import UTC, datetime

from app.providers.base import ModelInfo

# TTL applied to entries loaded back from SQLite (the persisted TTL is not
# stored; this just avoids re-querying the DB on every get).
_SQLITE_RELOAD_TTL_SEC = 300.0


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class CatalogCache:
    """Caches ``list_models`` results per provider with a per-provider TTL.

    ``get`` returns ``None`` on a miss or expiry; ``get_stale`` returns the last
    known result even after expiry so callers can serve stale on a network
    failure. An optional ETag is stored for conditional fetches.

    When a ``sqlite3.Connection`` is provided, ``set`` upserts each model into
    the ``model_catalog`` table and ``get``/``get_stale`` fall back to it when
    the in-memory entry is absent (e.g. after a restart).
    """

    def __init__(self, db: sqlite3.Connection | None = None) -> None:
        self._entries: dict[str, tuple[float, list[ModelInfo], str | None]] = {}
        self._db = db

    def get(self, provider: str) -> list[ModelInfo] | None:
        entry = self._entries.get(provider)
        if entry is not None:
            expires_at, models, _ = entry
            if time.monotonic() < expires_at:
                return models
            return None  # expired in-memory entry
        return self._load(provider)

    def get_stale(self, provider: str) -> list[ModelInfo] | None:
        entry = self._entries.get(provider)
        if entry is not None:
            return entry[1]
        return self._load(provider)

    def get_etag(self, provider: str) -> str | None:
        entry = self._entries.get(provider)
        if entry is not None:
            return entry[2]
        return self._load_etag(provider)

    def set(
        self,
        provider: str,
        models: list[ModelInfo],
        ttl_sec: float,
        etag: str | None = None,
    ) -> None:
        self._entries[provider] = (time.monotonic() + ttl_sec, list(models), etag)
        self._persist(provider, models, etag)

    def invalidate(self, provider: str | None = None) -> None:
        if provider is None:
            self._entries.clear()
            if self._db is not None:
                self._execute("DELETE FROM model_catalog")
        else:
            self._entries.pop(provider, None)
            if self._db is not None:
                self._execute(
                    "DELETE FROM model_catalog WHERE provider = ?", (provider,)
                )

    # ── SQLite backing ────────────────────────────────────────────────

    def _execute(self, sql: str, params: tuple = ()) -> None:
        try:
            self._db.execute(sql, params)
            self._db.commit()
        except sqlite3.Error:
            pass

    def _persist(
        self, provider: str, models: list[ModelInfo], etag: str | None
    ) -> None:
        if self._db is None:
            return
        fetched = _now_iso()
        try:
            self._db.execute(
                "DELETE FROM model_catalog WHERE provider = ?", (provider,)
            )
            for model in models:
                self._db.execute(
                    "INSERT OR REPLACE INTO model_catalog"
                    " (provider, model_id, payload_json, fetched_at, etag)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (provider, model.id, json.dumps(asdict(model)), fetched, etag),
                )
            self._db.commit()
        except sqlite3.Error:
            pass

    def _load(self, provider: str) -> list[ModelInfo] | None:
        if self._db is None:
            return None
        try:
            rows = self._db.execute(
                "SELECT payload_json, etag FROM model_catalog WHERE provider = ?"
                " ORDER BY model_id",
                (provider,),
            ).fetchall()
        except sqlite3.Error:
            return None
        if not rows:
            return None
        models: list[ModelInfo] = []
        etag: str | None = None
        for payload, row_etag in rows:
            try:
                models.append(ModelInfo(**json.loads(payload)))
            except (TypeError, ValueError):
                continue
            if etag is None and row_etag:
                etag = row_etag
        if not models:
            return None
        # Repopulate the in-memory entry so repeated gets avoid SQLite.
        self._entries[provider] = (
            time.monotonic() + _SQLITE_RELOAD_TTL_SEC,
            models,
            etag,
        )
        return models

    def _load_etag(self, provider: str) -> str | None:
        if self._db is None:
            return None
        try:
            row = self._db.execute(
                "SELECT etag FROM model_catalog"
                " WHERE provider = ? AND etag IS NOT NULL LIMIT 1",
                (provider,),
            ).fetchone()
        except sqlite3.Error:
            return None
        return row[0] if row else None
