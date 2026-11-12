"""Approvals API endpoints for reviewing and resolving tool execution requests."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator

from app.auth.dependencies import AuthContext, get_db, require_device
from app.db.repositories.approvals import ApprovalRepo

router = APIRouter(prefix="/v1/approvals", tags=["approvals"])


class ApprovalResponse(BaseModel):
    id: str
    action_hash: str
    tool_name: str
    arguments: dict[str, Any]
    status: str
    expires_at: float
    requested_by: str
    resolved_by: str | None = None
    created_at: float
    resolved_at: float | None = None


class ResolveApprovalRequest(BaseModel):
    decision: str

    @field_validator("decision")
    @classmethod
    def validate_decision(cls, v: str) -> str:
        if v not in ("approved", "rejected"):
            raise ValueError("decision must be either 'approved' or 'rejected'")
        return v


@router.get("/pending", response_model=list[ApprovalResponse])
def list_pending_approvals(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
    requested_by: str | None = None,
) -> list[ApprovalResponse]:
    """Return pending unexpired approvals, optionally filtered by requester."""
    repo = ApprovalRepo(db)
    items = repo.list_pending(requested_by=requested_by)
    return [ApprovalResponse(**item) for item in items]


@router.post("/{approval_id}/resolve", response_model=ApprovalResponse)
def resolve_approval(
    approval_id: str,
    req: ResolveApprovalRequest,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> ApprovalResponse:
    """Resolve a pending tool-call approval with 'approved' or 'rejected'."""
    repo = ApprovalRepo(db)
    resolved = repo.resolve(approval_id, req.decision, resolved_by=ctx.user_id)
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Approval request not found, already resolved, or expired",
        )
    return ApprovalResponse(**resolved)
