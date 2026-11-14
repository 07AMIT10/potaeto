"""Memory governance endpoints at `/v1/memory`."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.auth.dependencies import AuthContext, get_db, require_device
from app.db.repositories.memories import Memory, MemoryRepo
from app.memory.service import MemoryService

router = APIRouter(prefix="/v1/memory", tags=["memory"])


class MemoryResponse(BaseModel):
    id: str
    user_id: str
    entity_id: str | None
    kind: str
    content: str
    source: str | None
    source_ref: str | None
    confidence: float
    sensitivity: str
    scope: str
    status: str
    valid_from: str | None
    valid_to: str | None
    supersedes: str | None
    user_confirmed: bool
    created_at: str
    updated_at: str
    rrf_score: float | None = None

    @classmethod
    def from_memory(cls, m: Memory) -> MemoryResponse:
        return cls(
            id=m.id,
            user_id=m.user_id,
            entity_id=m.entity_id,
            kind=m.kind,
            content=m.content,
            source=m.source,
            source_ref=m.source_ref,
            confidence=m.confidence,
            sensitivity=m.sensitivity,
            scope=m.scope,
            status=m.status,
            valid_from=m.valid_from,
            valid_to=m.valid_to,
            supersedes=m.supersedes,
            user_confirmed=bool(m.user_confirmed),
            created_at=m.created_at,
            updated_at=m.updated_at,
            rrf_score=getattr(m, "rrf_score", None),
        )


class MemoryListResponse(BaseModel):
    memories: list[MemoryResponse]


class SupersedeRequest(BaseModel):
    content: str = Field(min_length=1)


@router.get("", response_model=MemoryListResponse)
def list_memories(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> MemoryListResponse:
    """List memories for the authenticated user, optionally filtered by status."""
    repo = MemoryRepo(db)
    memories = repo.list(
        user_id=ctx.user_id,
        status=status if status else None,
        limit=limit,
    )
    return MemoryListResponse(memories=[MemoryResponse.from_memory(m) for m in memories])


@router.get("/search", response_model=MemoryListResponse)
def search_memories(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
    q: str = Query(min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
    rrf_k: int = Query(default=60, ge=1, le=100),
) -> MemoryListResponse:
    """Hybrid search memories for the authenticated user using vector KNN + FTS RRF."""
    repo = MemoryRepo(db)
    memories = repo.hybrid_search(
        query=q,
        top_k=limit,
        rrf_k=rrf_k,
        user_id=ctx.user_id,
    )
    return MemoryListResponse(memories=[MemoryResponse.from_memory(m) for m in memories])


@router.post("/{memory_id}/retract")
def retract_memory(
    memory_id: str,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> dict[str, Any]:
    """Retract a memory by id."""
    service = MemoryService(db)
    try:
        service.retract(memory_id)
    except LookupError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"memory {memory_id} not found",
        ) from exc
    return {"status": "retracted", "id": memory_id}


@router.post("/{memory_id}/supersede")
def supersede_memory(
    memory_id: str,
    req: SupersedeRequest,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> dict[str, Any]:
    """Supersede a memory with new content."""
    service = MemoryService(db)
    try:
        new_id = service.supersede(memory_id, content=req.content)
    except LookupError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"memory {memory_id} not found",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return {"superseded": memory_id, "by": new_id}


@router.post("/{memory_id}/confirm")
def confirm_memory(
    memory_id: str,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> dict[str, Any]:
    """Confirm a candidate memory."""
    service = MemoryService(db)
    try:
        service.confirm(memory_id)
    except LookupError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"memory {memory_id} not found",
        ) from exc
    return {"confirmed": memory_id, "user_confirmed": True}
