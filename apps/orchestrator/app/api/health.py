"""Public health endpoint."""

from __future__ import annotations

import sqlite3
import time

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.db.repositories.base import fetch_one

router = APIRouter(prefix="/v1", tags=["health"])


class HealthResponse(BaseModel):
    status: str
    version: str
    db: str
    uptime_sec: float


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    """Report liveness plus a cheap database probe. Public by design."""
    try:
        fetch_one(request.app.state.db, "SELECT 1")
        db_status = "ok"
    except sqlite3.Error:
        db_status = "error"

    settings = request.app.state.settings
    uptime = time.monotonic() - request.app.state.started_at
    return HealthResponse(
        status="ok" if db_status == "ok" else "degraded",
        version=settings.version,
        db=db_status,
        uptime_sec=round(uptime, 3),
    )
