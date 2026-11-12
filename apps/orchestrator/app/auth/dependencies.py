"""FastAPI dependencies for authenticated device requests."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from app.auth.tokens import hash_token
from app.db.repositories.devices import DeviceRepo

_BEARER_SCHEME = "bearer"

# The PWA authenticates with an HttpOnly cookie instead of a long-lived bearer
# token in localStorage. `POST /v1/auth/pair` sets this cookie; `require_device`
# accepts it whenever no `Authorization: Bearer` header is present.
DEVICE_COOKIE_NAME = "potaeto_device"
DEVICE_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60  # 30 days


@dataclass(frozen=True)
class AuthContext:
    """Identity attached to every authenticated request."""

    user_id: str
    device_id: str


def get_db(request: Request) -> sqlite3.Connection:
    """Return the connection stored on the app by the app factory/tests."""
    db = getattr(request.app.state, "db", None)
    if db is None:  # pragma: no cover - misconfigured app
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database not initialized",
        )
    return db


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _extract_device_token(request: Request) -> str | None:
    """Return the bearer token, or the HttpOnly device cookie as a fallback."""
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() == _BEARER_SCHEME and token:
        return token
    cookie = request.cookies.get(DEVICE_COOKIE_NAME, "").strip()
    return cookie or None


def require_device(request: Request) -> AuthContext:
    """Resolve an active device from a bearer token or the device cookie, else 401."""
    token = _extract_device_token(request)
    if not token:
        raise _unauthorized("missing bearer token")

    device = DeviceRepo(get_db(request)).get_by_token_hash(hash_token(token))
    if device is None or device.revoked_at is not None:
        raise _unauthorized("invalid or revoked device token")
    return AuthContext(user_id=device.user_id, device_id=device.id)
