"""Audit event repository (append-only trail of privileged actions)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row, new_id, transaction


@dataclass(frozen=True)
class AuditEvent:
    id: str
    ts: str
    actor: str | None
    kind: str
    subject: str | None
    detail_json: dict[str, Any]


class AuditRepo(BaseRepo):
    table = "audit_events"

    def create(
        self,
        kind: str,
        *,
        actor: str | None = None,
        subject: str | None = None,
        detail: dict[str, Any] | None = None,
        event_id: str | None = None,
    ) -> AuditEvent:
        identifier = event_id or new_id("a")
        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO audit_events (id, actor, kind, subject, detail_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (identifier, actor, kind, subject, dump_json(detail or {})),
            )
        return self.require(self.get(identifier), "audit event", identifier)

    def get(self, event_id: str) -> AuditEvent | None:
        row = self._one("SELECT * FROM audit_events WHERE id = ?", (event_id,))
        return None if row is None else from_row(AuditEvent, row, ("detail_json",))

    def list(
        self, *, kind: str | None = None, actor: str | None = None, limit: int = 100
    ) -> list[AuditEvent]:
        clauses: list[str] = []
        params: list[Any] = []
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        if actor is not None:
            clauses.append("actor = ?")
            params.append(actor)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        rows = self._all(
            f"SELECT * FROM audit_events{where} ORDER BY ts DESC, rowid DESC LIMIT ?",
            params,
        )
        return [from_row(AuditEvent, row, ("detail_json",)) for row in rows]
