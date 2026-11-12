"""Server-authoritative sync endpoints: pull, push, and ack.

All routes require a paired device. The device identity always comes from the
bearer token, so a body ``device_id`` (kept for the documented wire shape) is
ignored rather than trusted.
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.auth.dependencies import AuthContext, get_db, require_device
from app.db.repositories.sync import PushOperation, SyncChange, SyncRepo

router = APIRouter(prefix="/v1/sync", tags=["sync"])

_DEFAULT_LIMIT = 500
_MAX_LIMIT = 1000


class SyncChangeResponse(BaseModel):
    seq: int
    entity_type: str
    entity_id: str
    operation: str
    payload: dict[str, Any]
    server_created_at: str

    @classmethod
    def from_change(cls, change: SyncChange) -> SyncChangeResponse:
        return cls(
            seq=change.seq,
            entity_type=change.entity_type,
            entity_id=change.entity_id,
            operation=change.operation,
            payload=change.payload_json or {},
            server_created_at=change.server_created_at,
        )


class SyncResponse(BaseModel):
    changes: list[SyncChangeResponse]
    next_seq: int
    has_more: bool


class PushOperationRequest(BaseModel):
    idempotency_key: str = Field(min_length=1)
    entity_type: str = Field(min_length=1)
    entity_id: str = Field(min_length=1)
    base_rev: int = Field(default=0, ge=0)
    payload: dict[str, Any] = Field(default_factory=dict)


class PushRequest(BaseModel):
    device_id: str | None = None
    operations: list[PushOperationRequest] = Field(default_factory=list)


class PushResultResponse(BaseModel):
    idempotency_key: str
    status: str
    rev: int | None = None
    seq: int | None = None
    error: str | None = None


class PushResponse(BaseModel):
    results: list[PushResultResponse]


class AckRequest(BaseModel):
    device_id: str | None = None
    seq: int = Field(ge=0)


class AckResponse(BaseModel):
    ok: bool = True


@router.get("", response_model=SyncResponse)
def get_changes(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
    after_seq: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=_MAX_LIMIT)] = _DEFAULT_LIMIT,
) -> SyncResponse:
    """Return the change log after the device cursor, oldest first."""
    repo = SyncRepo(db)
    # Read one extra row to report whether another page exists.
    rows = repo.get_changes(after_seq, limit + 1)
    has_more = len(rows) > limit
    page = rows[:limit]
    return SyncResponse(
        changes=[SyncChangeResponse.from_change(change) for change in page],
        next_seq=page[-1].seq if page else after_seq,
        has_more=has_more,
    )


@router.post("/push", response_model=PushResponse)
def push(
    req: PushRequest,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> PushResponse:
    """Apply client writes in order and return one result per operation."""
    results = SyncRepo(db).push(
        ctx.device_id,
        [
            PushOperation(
                idempotency_key=op.idempotency_key,
                entity_type=op.entity_type,
                entity_id=op.entity_id,
                base_rev=op.base_rev,
                payload=op.payload,
            )
            for op in req.operations
        ],
    )
    return PushResponse(
        results=[
            PushResultResponse(
                idempotency_key=result.idempotency_key,
                status=result.status,
                rev=result.rev,
                seq=result.seq,
                error=result.error,
            )
            for result in results
        ]
    )


@router.post("/ack", response_model=AckResponse)
def ack(
    req: AckRequest,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> AckResponse:
    """Advance the authenticated device's applied cursor (never backwards)."""
    SyncRepo(db).ack(ctx.device_id, req.seq)
    return AckResponse(ok=True)
