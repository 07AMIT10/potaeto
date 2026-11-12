"""Scheduled job repository (definitions only; the scheduler lands later)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row, new_id, transaction


@dataclass(frozen=True)
class Job:
    id: str
    name: str
    schedule: str | None
    timezone: str | None
    workflow_json: dict[str, Any]
    enabled: int
    last_run: str | None
    next_run: str | None
    lease_owner: str | None
    lease_until: str | None
    attempt_count: int
    misfire_policy: str
    idempotency_key: str | None
    created_at: str


class JobRepo(BaseRepo):
    table = "jobs"
    _UPDATABLE = (
        "name",
        "schedule",
        "timezone",
        "workflow_json",
        "enabled",
        "last_run",
        "next_run",
        "lease_owner",
        "lease_until",
        "attempt_count",
        "misfire_policy",
        "idempotency_key",
    )

    def _to_model(self, row) -> Job:
        return from_row(Job, row, ("workflow_json",))

    def create(
        self,
        name: str,
        *,
        schedule: str | None = None,
        timezone: str | None = None,
        workflow: dict[str, Any] | None = None,
        enabled: bool = True,
        next_run: str | None = None,
        misfire_policy: str = "skip",
        idempotency_key: str | None = None,
        job_id: str | None = None,
    ) -> Job:
        identifier = job_id or new_id("j")
        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO jobs (
                    id, name, schedule, timezone, workflow_json, enabled, next_run,
                    misfire_policy, idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    name,
                    schedule,
                    timezone,
                    dump_json(workflow or {}),
                    1 if enabled else 0,
                    next_run,
                    misfire_policy,
                    idempotency_key,
                ),
            )
        return self.require(self.get(identifier), "job", identifier)

    def get(self, job_id: str) -> Job | None:
        row = self._one("SELECT * FROM jobs WHERE id = ?", (job_id,))
        return None if row is None else self._to_model(row)

    def list(self, *, enabled: bool | None = None) -> list[Job]:
        if enabled is None:
            rows = self._all("SELECT * FROM jobs ORDER BY created_at")
        else:
            rows = self._all(
                "SELECT * FROM jobs WHERE enabled = ? ORDER BY created_at", (1 if enabled else 0,)
            )
        return [self._to_model(row) for row in rows]

    def update(self, job_id: str, **fields: Any) -> Job:
        self._update(job_id, fields, self._UPDATABLE, bump_rev=False, touch=False)
        return self.require(self.get(job_id), "job", job_id)

    def due(self, now: str | None = None) -> list[Job]:
        """Enabled jobs whose `next_run` is at or before `now` (UTC)."""
        rows = self._all(
            """
            SELECT * FROM jobs
            WHERE enabled = 1 AND next_run IS NOT NULL
              AND next_run <= COALESCE(?, datetime('now'))
            ORDER BY next_run
            """,
            (now,),
        )
        return [self._to_model(row) for row in rows]
