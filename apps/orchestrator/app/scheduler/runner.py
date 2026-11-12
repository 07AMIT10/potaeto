"""Durable cron scheduler backed by SQLite leases.

A worker claims a due job with one conditional ``UPDATE``; while the lease is
live any competing claim changes no rows. :class:`JobRunner` executes a leased
job's workflow steps and then completes it, recording a ``job_runs`` row and
advancing ``next_run`` from the completion time, so missed windows collapse
into a single run instead of a catch-up storm.

`croniter` parses the 5-field cron expression and `zoneinfo` resolves the
schedule's timezone; both are evaluated against the stored UTC ``next_run``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import sqlite3
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter  # type: ignore

from app.db.repositories.base import dump_json, new_id
from app.db.repositories.jobs import Job, JobRepo
from app.workflows.engine import WorkflowEngine

logger = logging.getLogger(__name__)

#: A step callback receives the notification text and must finish sending it.
Notify = Callable[[str], Awaitable[None]]


#: How long a claimed job stays invisible to other workers before it can be
#: reclaimed (a crashed worker must not hold a job forever).
LEASE_SECONDS = 300

#: Timestamps are stored in SQLite's canonical UTC text form, which also sorts
#: lexicographically for the `next_run <= now` predicates.
_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def _to_db(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime(_TIME_FORMAT)


def _parse_db(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _normalize_now(now: datetime | str | None) -> str:
    """Coerce a scheduler clock reading into the stored UTC text form."""
    if now is None:
        return _to_db(datetime.now(UTC))
    if isinstance(now, str):
        return _to_db(_parse_db(now))
    return _to_db(now)


def _load_zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"unknown timezone: {name!r}") from exc


def _next_after(moment: datetime, schedule: str, zone: ZoneInfo) -> datetime:
    """Return the first cron occurrence strictly after `moment`, in UTC."""
    local = moment.astimezone(zone)
    try:
        following = croniter(schedule, local).get_next(datetime)
    except (KeyError, ValueError) as exc:
        raise ValueError(f"invalid cron schedule: {schedule!r}") from exc
    return following.astimezone(UTC)


def _encode_output(output: Any) -> str | None:
    if output is None:
        return None
    return output if isinstance(output, str) else dump_json(output)


class Scheduler:
    """Create due jobs, claim them atomically, and record their completion."""

    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        owner: str | None = None,
        lease_seconds: int = LEASE_SECONDS,
    ) -> None:
        self.db = db
        self.jobs = JobRepo(db)
        self.owner = (
            owner or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        )
        self.lease_seconds = lease_seconds

    def create_job(
        self,
        name: str,
        schedule: str,
        timezone: str,
        workflow_json: dict[str, Any],
    ) -> Job:
        """Persist a job and compute its first timezone-aware `next_run`."""
        schedule = schedule.strip()
        if len(schedule.split()) != 5:
            raise ValueError(f"invalid cron schedule: {schedule!r} (expected 5 fields)")
        zone = _load_zone(timezone)
        next_run = _next_after(datetime.now(UTC), schedule, zone)
        return self.jobs.create(
            name,
            schedule=schedule,
            timezone=timezone,
            workflow=workflow_json,
            next_run=_to_db(next_run),
            misfire_policy="run_once",
        )

    def lease_due(self, now: datetime | str | None = None) -> list[Job]:
        """Claim every enabled job due at `now`, returning only won claims."""
        now_text = _normalize_now(now)
        lease_until = _to_db(
            _parse_db(now_text) + timedelta(seconds=self.lease_seconds)
        )
        leased: list[Job] = []
        # The conditional UPDATE is the single-flight gate: after another worker
        # wins the row, `lease_until` is live and this WHERE clause matches zero.
        with self.jobs.write_transaction():
            candidates = self.db.execute(
                """
                SELECT id FROM jobs
                WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
                  AND (lease_until IS NULL OR lease_until < ?)
                ORDER BY next_run, id
                """,
                (now_text, now_text),
            ).fetchall()
            for row in candidates:
                claimed = self.db.execute(
                    """
                    UPDATE jobs SET lease_owner = ?, lease_until = ?
                    WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)
                    """,
                    (self.owner, lease_until, row["id"], now_text),
                )
                if claimed.rowcount != 1:
                    continue
                job = self.jobs.get(row["id"])
                if job is not None:
                    leased.append(job)
        return leased

    def complete(self, job_id: str, status: str, output: Any) -> Job:
        """Record a run, release the lease, and move `next_run` into the future."""
        with self.jobs.write_transaction():
            job = self.jobs.require(self.jobs.get(job_id), "job", job_id)
            finished_at = datetime.now(UTC)
            next_run: str | None = None
            if job.schedule and job.timezone:
                # Re-run the schedule from the later of "now" and the occurrence
                # just completed: a missed window fires once, then advances.
                base = finished_at
                if job.next_run:
                    base = max(base, _parse_db(job.next_run))
                next_run = _to_db(
                    _next_after(base, job.schedule, _load_zone(job.timezone))
                )
            self.db.execute(
                """
                INSERT INTO job_runs (id, job_id, status, started_at, finished_at, output)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("jr"),
                    job_id,
                    status,
                    # `started_at` names the scheduled occurrence this run covers.
                    job.next_run,
                    _to_db(finished_at),
                    _encode_output(output),
                ),
            )
            self.db.execute(
                """
                UPDATE jobs
                SET last_run = ?, next_run = ?, lease_owner = NULL, lease_until = NULL,
                    attempt_count = attempt_count + 1
                WHERE id = ?
                """,
                (_to_db(finished_at), next_run, job_id),
            )
        return self.jobs.require(self.jobs.get(job_id), "job", job_id)


class JobRunner:
    """Execute due jobs one at a time, under the scheduler's lease.

    Executes jobs via WorkflowEngine to run full step pipelines under durable
    governance, recording status and output in ``job_runs``.
    """

    def __init__(
        self,
        scheduler: Scheduler,
        notify: Notify | None = None,
        *,
        engine: WorkflowEngine | None = None,
        registry: Any = None,
        provider: Any = None,
        telegram_bot: Any = None,
    ) -> None:
        self.scheduler = scheduler
        self.notify = notify
        self.engine = engine
        self.registry = registry
        self.provider = provider
        self.telegram_bot = telegram_bot or notify

    async def run_once(self, now: datetime | str | None = None) -> list[Job]:
        """Lease and execute every job due at `now`; return the completed jobs."""
        completed: list[Job] = []
        for job in self.scheduler.lease_due(now):
            try:
                status, output = await self._execute(job)
            except Exception as exc:  # noqa: BLE001 - always release the lease
                status, output = (
                    "error",
                    {
                        "error": f"{type(exc).__name__}: {exc}",
                        "steps": [],
                    },
                )
            completed.append(self.scheduler.complete(job.id, status, output))
        return completed

    async def run_forever(self, interval_sec: float = 30) -> None:
        """Poll until cancelled; one failing run never kills the worker."""
        while True:
            try:
                await self.run_once()
            except Exception:  # a bad job must not stop the loop
                logger.exception("scheduler: job run failed")
            await asyncio.sleep(interval_sec)

    async def _execute(self, job: Job) -> tuple[str, dict[str, Any]]:
        workflow = job.workflow_json
        if not isinstance(workflow, dict):
            return "error", {"error": "workflow_json must be an object", "steps": []}
        steps = workflow.get("steps", [])
        if not isinstance(steps, list):
            return "error", {"error": "'steps' must be a list", "steps": []}

        engine = self.engine or WorkflowEngine(
            registry=self.registry,
            db_conn=self.scheduler.db,
            provider=self.provider,
            telegram_bot=self.telegram_bot or self.notify,
        )
        res = await engine.execute_workflow(steps)
        status = "success" if res["status"] == "completed" else "error"
        return status, res
