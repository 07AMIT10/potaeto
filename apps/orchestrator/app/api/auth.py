"""Device pairing and identity endpoints."""

from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from app.api.rate_limit import client_ip, enforce_rate_limit
from app.auth.dependencies import (
    DEVICE_COOKIE_MAX_AGE_SEC,
    DEVICE_COOKIE_NAME,
    AuthContext,
    get_db,
    require_device,
)
from app.auth.pairing import PairingError, PairingService
from app.db.repositories.devices import DeviceRepo

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class PairRequest(BaseModel):
    code: str = Field(min_length=1)
    device_name: str = Field(min_length=1)


class PairResponse(BaseModel):
    device_id: str
    token: str
    user_id: str


class DeviceResponse(BaseModel):
    device_id: str
    user_id: str
    name: str | None
    last_seen: str | None
    created_at: str


@router.post("/pair", response_model=PairResponse)
def pair(req: PairRequest, request: Request, response: Response) -> PairResponse:
    """Exchange a pairing code for a device token (token is returned once).

    The token is also set as an HttpOnly, SameSite=Lax cookie so the PWA can
    authenticate without storing a bearer token in localStorage. ``Secure``
    comes from ``POTAETO_COOKIE_SECURE`` (default true), not Node's
    ``NODE_ENV``, which Python never sets.
    """
    # Public endpoint: throttle per client IP before touching the pairing store.
    # Invalid codes still get the same uniform 401 until the budget is spent.
    enforce_rate_limit(
        request,
        f"pair:{client_ip(request)}",
        request.app.state.settings.rate_limit_pair_per_min,
    )
    try:
        result = PairingService(get_db(request)).exchange(req.code, req.device_name)
    except PairingError as exc:
        # Same message for unknown, expired, and already-used codes.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired pairing code",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    response.set_cookie(
        key=DEVICE_COOKIE_NAME,
        value=result.token,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=DEVICE_COOKIE_MAX_AGE_SEC,
        secure=request.app.state.settings.cookie_secure,
    )
    return PairResponse(device_id=result.device_id, token=result.token, user_id=result.user_id)


@router.get("/me", response_model=DeviceResponse)
def me(
    ctx: Annotated[AuthContext, Depends(require_device)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
) -> DeviceResponse:
    """Return the device identified by the bearer token."""
    device = DeviceRepo(db).get(ctx.device_id)
    if device is None:  # pragma: no cover - token lookup and this lookup agree
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="device not found",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return DeviceResponse(
        device_id=device.id,
        user_id=device.user_id,
        name=device.name,
        last_seen=device.last_seen,
        created_at=device.created_at,
    )
