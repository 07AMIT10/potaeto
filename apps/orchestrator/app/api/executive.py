"""Executive API router for briefings and memory consolidation."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth.dependencies import AuthContext, get_db, require_device
from app.services.executive import ExecutiveService

router = APIRouter(prefix="/v1/executive", tags=["executive"])


class BriefingRequest(BaseModel):
    hours: int = Field(default=24, ge=1, le=168)


class BriefingResponse(BaseModel):
    briefing: str
    generated_at: str
    vitals: dict[str, Any]
    pending_approvals_count: int
    pending_approvals: list[dict[str, Any]]
    active_tasks_count: int
    active_tasks: list[dict[str, Any]]
    high_importance_memories_count: int
    high_importance_memories: list[dict[str, Any]]


class ConsolidateRequest(BaseModel):
    cluster_threshold: float = Field(default=0.65, ge=0.0, le=1.0)
    merger_threshold: float = Field(default=0.85, ge=0.0, le=1.0)
    limit: int = Field(default=50, ge=2, le=200)


class ConsolidateResponse(BaseModel):
    candidates_analyzed: int
    clusters_count: int
    clusters: list[dict[str, Any]]
    mergers: list[dict[str, Any]]
    contradictions: list[dict[str, Any]]
    consolidated_at: str


@router.post("/briefing", response_model=BriefingResponse)
def get_morning_briefing(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
    payload: BriefingRequest | None = None,
) -> BriefingResponse:
    """Generate an executive morning briefing combining vitals, tasks, and memory."""
    hours = payload.hours if payload else 24
    svc = ExecutiveService(db)
    result = svc.generate_morning_briefing(user_id=ctx.user_id, hours=hours)
    return BriefingResponse(**result)


@router.post("/consolidate", response_model=ConsolidateResponse)
def consolidate_memories(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
    payload: ConsolidateRequest | None = None,
) -> ConsolidateResponse:
    """Consolidate candidate memories by clustering and identifying contradictions/mergers."""
    req = payload or ConsolidateRequest()
    svc = ExecutiveService(db)
    result = svc.consolidate_memories(
        user_id=ctx.user_id,
        cluster_threshold=req.cluster_threshold,
        merger_threshold=req.merger_threshold,
        limit=req.limit,
    )
    return ConsolidateResponse(**result)


__all__ = ["router"]
