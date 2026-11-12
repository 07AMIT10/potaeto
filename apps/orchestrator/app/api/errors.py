"""JSON error envelope shared by every API route.

Every error response has the shape ``{"error": {"code": ..., "message": ...}}``.
``detail`` is retained alongside the envelope while Task 3's auth contract is
still in use, so existing clients keep seeing the field they expect.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.audit import audit_safely

logger = logging.getLogger(__name__)

_STATUS_CODE_NAMES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
    503: "unavailable",
}


def error_code(status_code: int) -> str:
    """Map an HTTP status to a stable machine-readable error code."""
    return _STATUS_CODE_NAMES.get(status_code, "http_error")


def error_body(code: str, message: str) -> dict[str, Any]:
    """Build the error envelope."""
    return {"error": {"code": code, "message": message}}


def install_error_handlers(app: FastAPI) -> None:
    """Register handlers that render every error as the JSON envelope."""

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        if exc.status_code in (401, 403):
            # Never log the credential itself: only the path and method.
            audit_safely(
                getattr(request.app.state, "db", None),
                None,
                "auth_failed",
                request.url.path,
                {
                    "method": request.method,
                    "status": exc.status_code,
                    "client": request.client.host if request.client else None,
                },
            )
        detail = exc.detail
        message = detail if isinstance(detail, str) else "request failed"
        body = error_body(error_code(exc.status_code), message)
        # Task 3's auth responses (and their tests) read ``detail``.
        body["detail"] = detail
        return JSONResponse(
            content=jsonable_encoder(body),
            status_code=exc.status_code,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        body = error_body("validation_error", "invalid request")
        body["detail"] = exc.errors()
        return JSONResponse(content=jsonable_encoder(body), status_code=422)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            content=error_body("internal_error", "internal server error"),
            status_code=500,
        )
