"""Authenticated model catalog and active-model picker.

The catalog is the normalized :class:`~app.providers.base.ModelInfo` list for
every configured provider: context window, max output, tool support, pricing,
and data-retention class. API keys never appear here — providers expose only
the metadata they discovered.

``POST /v1/models/active`` persists the picker's choice (so it survives a
restart) and re-resolves provider candidates for subsequent turns.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.auth.dependencies import AuthContext, get_db, require_device
from app.model_selection import (
    apply_model_selection,
    read_active_selection,
    write_active_selection,
)
from app.providers.base import ModelInfo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["models"])

#: Catalog fetches are network-backed. A per-provider cap keeps the endpoint
#: responsive even when one provider is slow or down.
CATALOG_TIMEOUT_SEC = 5.0


class ModelInfoResponse(BaseModel):
    provider: str
    id: str
    name: str
    context_length: int | None = None
    max_output_tokens: int | None = None
    supports_tools: bool = False
    protocol: str = "openai"
    pricing: dict[str, Any] | None = None
    retention: str | None = None

    @classmethod
    def from_info(cls, info: ModelInfo) -> ModelInfoResponse:
        return cls(
            provider=info.provider,
            id=info.id,
            name=info.name or info.id,
            context_length=info.context_length,
            max_output_tokens=info.max_output_tokens,
            supports_tools=info.supports_tools,
            protocol=info.protocol,
            pricing=info.pricing,
            retention=info.retention,
        )


class ModelCatalogResponse(BaseModel):
    models: list[ModelInfoResponse]
    active_model: str | None = None
    active_provider: str | None = None


class ActiveModelRequest(BaseModel):
    model: str = Field(min_length=1)
    provider: str | None = Field(default=None, min_length=1)


class ActiveModelResponse(BaseModel):
    active_model: str
    active_provider: str | None = None


async def _provider_models(provider: Any) -> list[ModelInfo]:
    try:
        return await asyncio.wait_for(provider.list_models(), CATALOG_TIMEOUT_SEC)
    except TimeoutError:
        logger.warning("model catalog fetch for %s timed out", provider.name)
    except Exception as exc:  # noqa: BLE001 - one bad provider must not hide the rest
        logger.warning(
            "model catalog fetch for %s failed (%s: %s)",
            provider.name,
            type(exc).__name__,
            exc,
        )
    return []


@router.get("/models", response_model=ModelCatalogResponse)
async def list_models(
    request: Request,
    ctx: Annotated[AuthContext, Depends(require_device)],
) -> ModelCatalogResponse:
    """Return the normalized catalog for every configured provider."""
    registry = getattr(request.app.state, "providers", None)
    names = registry.names() if registry is not None else []
    providers = [registry.get(name) for name in names]
    results = await asyncio.gather(
        *(_provider_models(provider) for provider in providers if provider is not None)
    )
    models = [ModelInfoResponse.from_info(info) for batch in results for info in batch]
    active = read_active_selection(request.app.state.db)
    return ModelCatalogResponse(
        models=models,
        active_model=request.app.state.model or None,
        active_provider=(active[1] or None) if active else None,
    )


@router.post("/models/active", response_model=ActiveModelResponse)
async def set_active_model(
    req: ActiveModelRequest,
    request: Request,
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> ActiveModelResponse:
    """Persist and apply the picker's model choice for future turns."""
    registry = getattr(request.app.state, "providers", None)
    if registry is None or not registry.names():
        raise HTTPException(status_code=503, detail="no provider configured")

    selected_provider = (req.provider or "").strip()
    if selected_provider and registry.get(selected_provider) is None:
        raise HTTPException(status_code=400, detail="unknown provider")

    await apply_model_selection(request.app, req.model, selected_provider)
    write_active_selection(db, req.model, selected_provider)
    return ActiveModelResponse(
        active_model=req.model, active_provider=selected_provider or None
    )
