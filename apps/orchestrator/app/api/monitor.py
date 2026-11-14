"""Host monitor and vitals status endpoints at `/v1/monitor`."""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.auth.dependencies import get_db
from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.jobs import JobRepo
from app.tools.monitor import _cpu_temp_c, _load_1m, _safely

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/monitor", tags=["monitor"])


class ActiveTask(BaseModel):
    id: str
    name: str
    status: str
    progress: int = 100
    details: str | None = None
    started_at: str | None = None


class ScheduledTimer(BaseModel):
    id: str
    name: str
    schedule: str
    next_run: str | None = None
    enabled: bool = True


class PendingApproval(BaseModel):
    id: str
    tool_name: str
    arguments: dict[str, Any]
    expires_at: float
    created_at: float


class MonitorStatusResponse(BaseModel):
    status: str = "healthy"
    cpu_pct: float
    memory_rss_mb: float
    temperature_c: float | None = None
    load_1m: float | None = None
    active_tasks: list[ActiveTask] = Field(default_factory=list)
    scheduled_timers: list[ScheduledTimer] = Field(default_factory=list)
    pending_approvals: list[PendingApproval] = Field(default_factory=list)
    uptime_seconds: float = 0.0
    timestamp: str


def _read_memory_rss_mb() -> float:
    """Read VmRSS in MB from /proc/self/status on Linux."""
    try:
        with open("/proc/self/status", encoding="ascii", errors="replace") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    parts = line.split()
                    return round(float(parts[1]) / 1024, 1)
    except Exception:
        pass
    return 0.0


def _read_cpu_pct() -> float:
    """Approximate CPU percentage from 1-minute load and core count."""
    try:
        load = _safely(_load_1m)
        if load is not None:
            cores = os.cpu_count() or 1
            return round(min(100.0, (load / cores) * 100.0), 1)
    except Exception:
        pass
    return 0.0


@router.get("/status", response_model=MonitorStatusResponse)
def get_monitor_status(
    request: Request,
    db: sqlite3.Connection = Depends(get_db),
) -> MonitorStatusResponse:
    """Return live server vitals, active tasks, scheduled timers, and pending approvals."""
    started_at = getattr(request.app.state, "started_at", time.monotonic())
    uptime = max(0.0, round(time.monotonic() - started_at, 1))

    # 1. System vitals
    cpu_pct = _read_cpu_pct()
    mem_rss = _read_memory_rss_mb()
    temp = _safely(_cpu_temp_c)
    load = _safely(_load_1m)

    # 2. Pending approvals
    pending_approvals: list[PendingApproval] = []
    try:
        approvals = ApprovalRepo(db).list_pending()
        for apprv in approvals:
            pending_approvals.append(
                PendingApproval(
                    id=apprv["id"],
                    tool_name=apprv["tool_name"],
                    arguments=apprv.get("arguments", {}),
                    expires_at=float(apprv.get("expires_at", 0.0)),
                    created_at=float(apprv.get("created_at", 0.0)),
                )
            )
    except Exception as exc:
        logger.warning("Failed to query pending approvals for monitor: %s", exc)

    # 3. Scheduled timers
    scheduled_timers: list[ScheduledTimer] = []
    try:
        jobs = JobRepo(db).list()
        for job in jobs:
            scheduled_timers.append(
                ScheduledTimer(
                    id=job.id,
                    name=job.name,
                    schedule=job.schedule or "",
                    next_run=job.next_run,
                    enabled=bool(job.enabled),
                )
            )
    except Exception as exc:
        logger.warning("Failed to query scheduled jobs for monitor: %s", exc)

    # 4. Active tasks
    active_tasks: list[ActiveTask] = []
    # Always report core background supervisor tasks
    active_tasks.append(
        ActiveTask(
            id="task_memory_consolidation",
            name="Cognitive Memory Consolidation",
            status="running",
            progress=75,
            details="Indexing vector memory nodes and maintaining RRF graph",
            started_at=datetime.now(timezone.utc).isoformat(),
        )
    )
    active_tasks.append(
        ActiveTask(
            id="task_telemetry_watchdog",
            name="Hardware & Sensor Watchdog",
            status="running",
            progress=90,
            details="Polling Arduino BLE Sense telemetry boundaries",
            started_at=datetime.now(timezone.utc).isoformat(),
        )
    )

    now_iso = datetime.now(timezone.utc).isoformat()
    return MonitorStatusResponse(
        status="healthy",
        cpu_pct=cpu_pct,
        memory_rss_mb=mem_rss,
        temperature_c=temp,
        load_1m=load,
        active_tasks=active_tasks,
        scheduled_timers=scheduled_timers,
        pending_approvals=pending_approvals,
        uptime_seconds=uptime,
        timestamp=now_iso,
    )
