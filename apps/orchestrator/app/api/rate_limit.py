"""Request-level rate limiting for public and high-cost routes.

The limiter itself is the single process-wide ``app.state.rate_limiter``; this
module only turns an empty bucket into the shared HTTP error envelope with a
``Retry-After`` header.
"""

from __future__ import annotations

import ipaddress
import math

from fastapi import HTTPException, Request, status

RATE_LIMIT_WINDOW_SEC = 60.0
_FORWARDED_HEADERS = ("x-forwarded-for", "cf-connecting-ip")


def _normalize(value: str | None) -> str | None:
    """Return a canonical IP string, or ``None`` for a malformed value."""
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if candidate.startswith("["):
        end = candidate.find("]")
        if end == -1:
            return None
        candidate = candidate[1:end]
    elif candidate.count(":") == 1:
        host, _, port = candidate.partition(":")
        if port.isdigit():
            candidate = host
    # Drop an IPv6 scope id (``fe80::1%eth0``).  # pii-scan: allow-private-ip
    candidate = candidate.split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return str(addr)


def _forwarded_address(request: Request) -> str | None:
    """First non-empty forwarded address, preferring ``X-Forwarded-For``."""
    for header in _FORWARDED_HEADERS:
        raw = request.headers.get(header, "")
        if header == "x-forwarded-for":
            for part in raw.split(","):
                if part.strip():
                    return part.strip()
        elif raw.strip():
            return raw.strip()
    return None


def client_ip(request: Request) -> str:
    """Resolve the caller IP, trusting forwarding headers only from loopback.

    The core binds ``127.0.0.1:8010`` in production, so Caddy is the only
    loopback peer and a remote caller cannot spoof ``X-Forwarded-For`` /
    ``CF-Connecting-IP``. (Development may run the core on ``8000``; the
    loopback-only trust rule is identical either way.) A non-loopback peer
    always wins over the headers. Values are canonicalized and validated;
    anything unusable falls back to ``"unknown"``.
    """
    peer = _normalize(request.client.host if request.client else None)
    if peer is None:
        return "unknown"
    if not ipaddress.ip_address(peer).is_loopback:
        return peer

    forwarded = _forwarded_address(request)
    if forwarded is None:
        return peer
    return _normalize(forwarded) or "unknown"


def enforce_rate_limit(
    request: Request,
    key: str,
    limit: int,
    *,
    window_sec: float = RATE_LIMIT_WINDOW_SEC,
) -> None:
    """Consume one token for `key`, or raise 429 with a ``Retry-After`` header.

    A non-positive limit denies every call, matching the limiter's fail-closed
    token-bucket semantics.
    """
    if request.app.state.rate_limiter.check(key, limit, window_sec):
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="too many requests; try again later",
        headers={"Retry-After": str(max(1, math.ceil(window_sec)))},
    )
