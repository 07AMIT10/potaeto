"""Tool-call repository: one row per model-requested tool invocation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row, new_id, transaction


@dataclass(frozen=True)
class ToolCall:
    id: str
    message_id: str | None
    name: str
    arguments_json: dict[str, Any]
    result_json: dict[str, Any] | None
    status: str
    started_at: str | None
    finished_at: str | None
    approval_id: str | None
    error_code: str | None
    retry_count: int


class ToolCallRepo(BaseRepo):
    table = "tool_calls"
    _UPDATABLE = (
        "status",
        "result_json",
        "started_at",
        "finished_at",
        "approval_id",
        "error_code",
        "retry_count",
    )

    def _to_model(self, row) -> ToolCall:
        return from_row(ToolCall, row, ("arguments_json", "result_json"))

    def create(
        self,
        name: str,
        *,
        message_id: str | None = None,
        arguments: dict[str, Any] | None = None,
        status: str = "pending",
        tool_call_id: str | None = None,
    ) -> ToolCall:
        identifier = tool_call_id or new_id("tc")
        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO tool_calls (id, message_id, name, arguments_json, status)
                VALUES (?, ?, ?, ?, ?)
                """,
                (identifier, message_id, name, dump_json(arguments or {}), status),
            )
        return self.require(self.get(identifier), "tool call", identifier)

    def get(self, tool_call_id: str) -> ToolCall | None:
        row = self._one("SELECT * FROM tool_calls WHERE id = ?", (tool_call_id,))
        return None if row is None else self._to_model(row)

    def list(
        self, *, message_id: str | None = None, status: str | None = None
    ) -> list[ToolCall]:
        clauses: list[str] = []
        params: list[Any] = []
        if message_id is not None:
            clauses.append("message_id = ?")
            params.append(message_id)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._all(f"SELECT * FROM tool_calls{where} ORDER BY rowid", params)
        return [self._to_model(row) for row in rows]

    def update(self, tool_call_id: str, **fields: Any) -> ToolCall:
        self._update(
            tool_call_id, fields, self._UPDATABLE, bump_rev=False, touch=False
        )
        return self.require(self.get(tool_call_id), "tool call", tool_call_id)

    def finish(
        self,
        tool_call_id: str,
        *,
        status: str,
        result: dict[str, Any] | None = None,
        error_code: str | None = None,
    ) -> ToolCall:
        """Mark a tool call finished, stamping `finished_at` in SQLite."""
        with transaction(self.conn):
            self.conn.execute(
                """
                UPDATE tool_calls
                SET status = ?, result_json = ?, error_code = ?,
                    finished_at = datetime('now')
                WHERE id = ?
                """,
                (status, None if result is None else dump_json(result), error_code, tool_call_id),
            )
        return self.require(self.get(tool_call_id), "tool call", tool_call_id)
