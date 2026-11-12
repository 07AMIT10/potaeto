"""Fail-closed admin surface.

Release 1 ships no admin endpoints, but every ``/v1/admin/*`` request must still
hit the guard: 503 when ``ADMIN_SECRET`` is unset, 401 unless the
``X-Admin-Secret`` header matches, and 404 for an authenticated unknown path.
The dependency lives on the router, so every admin route added later inherits it
without repeating the guard.
"""

from __future__ import annotations

import hmac
import os

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.audit import audit_safely

_ADMIN_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


def require_admin(request: Request) -> None:
    """Reject admin requests unless a configured secret matches the header."""
    db = getattr(request.app.state, "db", None)
    secret = os.environ.get("ADMIN_SECRET", "")
    if not secret:
        audit_safely(
            db,
            None,
            "admin_disabled",
            request.url.path,
            {"method": request.method},
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="admin interface disabled",
        )

    supplied = request.headers.get("X-Admin-Secret", "")
    if not hmac.compare_digest(supplied.encode("utf-8"), secret.encode("utf-8")):
        # The 401 itself is audited by the shared HTTP error handler.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid admin secret",
            headers={"WWW-Authenticate": "X-Admin-Secret"},
        )


router = APIRouter(
    prefix="/v1/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


@router.api_route("/{path:path}", methods=_ADMIN_METHODS)
def admin_unknown(path: str) -> None:
    """Guard every admin path even though no admin endpoint exists yet."""
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="unknown admin endpoint",
    )
