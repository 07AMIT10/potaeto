"""Scheduled job definitions at `/v1/jobs`.

Creating a job validates the cron expression and timezone and stores the first
`next_run`; executing workflows is the worker's job, not this router's. Every
route requires a paired device.
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.dependencies import AuthContext, get_db, require_device
from app.db.repositories.jobs import Job, JobRepo
from app.scheduler.runner import Scheduler

router = APIRouter(prefix="/v1/jobs", tags=["jobs"])


class JobResponse(BaseModel):
    id: str
    name: str
    schedule: str | None
    timezone: str | None
    workflow: dict[str, Any]
    enabled: bool
    last_run: str | None
    next_run: str | None
    attempt_count: int
    created_at: str

    @classmethod
    def from_job(cls, job: Job) -> JobResponse:
        return cls(
            id=job.id,
            name=job.name,
            schedule=job.schedule,
            timezone=job.timezone,
            workflow=job.workflow_json or {},
            enabled=bool(job.enabled),
            last_run=job.last_run,
            next_run=job.next_run,
            attempt_count=job.attempt_count,
            created_at=job.created_at,
        )


class JobListResponse(BaseModel):
    jobs: list[JobResponse]


class CreateJobRequest(BaseModel):
    name: str = Field(min_length=1)
    schedule: str = Field(min_length=1)
    timezone: str = Field(default="UTC", min_length=1)
    workflow: dict[str, Any] = Field(default_factory=dict)


@router.get("", response_model=JobListResponse)
def list_jobs(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> JobListResponse:
    """Return every job definition, in creation order."""
    return JobListResponse(
        jobs=[JobResponse.from_job(job) for job in JobRepo(db).list()]
    )


@router.post("", response_model=JobResponse, status_code=status.HTTP_201_CREATED)
def create_job(
    req: CreateJobRequest,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> JobResponse:
    """Create a cron job; an invalid schedule or timezone is a 422."""
    try:
        job = Scheduler(db).create_job(
            req.name, req.schedule, req.timezone, req.workflow
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JobResponse.from_job(job)
