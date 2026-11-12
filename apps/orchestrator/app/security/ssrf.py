"""Server-side request forgery (SSRF) containment for outbound HTTP.

Every outbound URL is checked before a connection is made and again after each
redirect:

* only ``http`` and ``https`` are allowed;
* the hostname is resolved and *every* answer must be public — loopback,
  private, link-local, multicast, unspecified, reserved, and cloud metadata
  addresses are refused;
* at most three redirects are followed and each target is revalidated;
* the response body is streamed into a buffer with a byte cap and the whole
  fetch shares one wall-clock deadline.

Policy violations raise :class:`SSRFError`; transport failures never raise and
come back as a :class:`FetchResult` with ``ok`` false and ``error`` set. Callers
that must never see an exception (tools that degrade gracefully) use
:meth:`SSRFSafeFetcher.fetch_or_error`.

DNS-rebinding note: the resolver is consulted immediately before each hop and
all answers are validated, but the subsequent connection resolves the name
again. Eliminating that time-of-check/time-of-use window needs socket-level
pinning, which is out of scope for the Release 1 baseline.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

logger = logging.getLogger(__name__)

DEFAULT_MAX_BYTES = 2_000_000
DEFAULT_TIMEOUT = 10.0
MAX_REDIRECTS = 3

_CHUNK_SIZE = 64 * 1024
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_ALLOWED_SCHEMES = frozenset({"http", "https"})
_USER_AGENT = "potaeto-core/0.1 (+https://github.com/potaeto)"

#: Resolve a hostname and port to its candidate addresses.
Resolver = Callable[[str, int], Sequence[str]]


class AuditSink(Protocol):
    """The slice of :class:`app.audit.AuditLog` this module needs."""

    def record(
        self,
        actor: str | None,
        kind: str,
        subject: str | None = None,
        detail: Mapping[str, object] | str | None = None,
    ) -> object: ...


@dataclass(frozen=True)
class FetchResult:
    """Outcome of one guarded fetch. ``ok`` is true only for a 2xx response."""

    url: str
    status_code: int | None = None
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""
    truncated: bool = False
    redirects: tuple[str, ...] = ()
    error: str | None = None

    @property
    def ok(self) -> bool:
        return (
            self.error is None
            and self.status_code is not None
            and 200 <= self.status_code < 300
        )

    @property
    def text(self) -> str:
        """Decode the body as UTF-8, replacing undecodable bytes."""
        return self.body.decode("utf-8", "replace")


class SSRFError(ValueError):
    """A URL was refused because it targets a non-public destination.

    The exception carries an equivalent error :class:`FetchResult` so a caller
    can surface the block without rebuilding it.
    """

    def __init__(self, reason: str, *, url: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.url = url
        self.result = FetchResult(url=url, error=reason)


def _is_blocked_address(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return whether an address is outside the public internet."""
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return (
        not addr.is_global
        or addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
    )


def is_blocked_ip(value: str) -> bool:
    """Return whether `value` is a refused address.

    Anything that is not a parsable IP address is blocked as well, so callers
    can treat this as a fail-closed predicate.
    """
    # IPv6 link-local addresses may carry a scope id (``fe80::1%eth0``).  # pii-scan: allow-private-ip
    candidate = value.strip().strip("[]").split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(candidate)
    except ValueError:
        return True
    return _is_blocked_address(addr)


def redact_url(url: str) -> str:
    """Return a URL safe for logs and audit: userinfo, query, and fragment removed.

    The scheme, host, optional port, and path are retained so an event still
    identifies the destination, while credentials and tokens embedded in the URL
    never reach the audit table.
    """
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return "<invalid url>"
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{host}:{port}" if port is not None else host
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def system_resolver(host: str, port: int) -> tuple[str, ...]:
    """Resolve `host` with the platform resolver, preserving order and deduping."""
    addresses: list[str] = []
    for family, _, _, _, sockaddr in socket.getaddrinfo(
        host, port, type=socket.SOCK_STREAM
    ):
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        address = str(sockaddr[0])
        if address not in addresses:
            addresses.append(address)
    return tuple(addresses)


def validate_url(url: str, *, resolver: Resolver | None = None) -> str:
    """Return the validated hostname, or raise :class:`SSRFError`.

    A URL is allowed only when its scheme is ``http``/``https``, it carries no
    userinfo, and every address its hostname resolves to is public. IP literals
    are checked directly and never consult the resolver.
    """
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        host = parts.hostname
        port = parts.port
    except ValueError as exc:
        raise SSRFError(f"invalid URL: {exc}", url=url) from exc

    if scheme not in _ALLOWED_SCHEMES:
        raise SSRFError(f"scheme {scheme or '(missing)'!r} is not allowed", url=url)
    if parts.username is not None or parts.password is not None:
        raise SSRFError("URLs with userinfo are not allowed", url=url)
    if not host:
        raise SSRFError("URL has no hostname", url=url)
    if port is not None and not 1 <= port <= 65535:
        raise SSRFError(f"invalid port ({port})", url=url)

    effective_port = port if port is not None else (443 if scheme == "https" else 80)
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        if resolver is not None:
            addresses = tuple(resolver(host, effective_port))
        else:
            addresses = system_resolver(host, effective_port)
        if not addresses:
            raise SSRFError(f"{host!r} did not resolve", url=url) from None
        for address in addresses:
            if is_blocked_ip(address):
                raise SSRFError(
                    f"{host!r} resolves to a blocked address ({address})", url=url
                )
    else:
        if _is_blocked_address(literal):
            raise SSRFError(f"blocked address ({literal})", url=url)
    return host


class SSRFSafeFetcher:
    """Fetch a URL with destination checks, redirect limits, and size/time caps."""

    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        audit: AuditSink | None = None,
        max_redirects: int = MAX_REDIRECTS,
    ) -> None:
        self._resolver = resolver or system_resolver
        self._transport = transport
        self._audit = audit
        self._max_redirects = max_redirects

    async def fetch(
        self,
        url: str,
        max_bytes: int = DEFAULT_MAX_BYTES,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> FetchResult:
        """Fetch `url`, raising :class:`SSRFError` only for policy violations.

        Transport failures (DNS errors, connection resets, invalid URLs that
        survive validation) return an error result instead of raising.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        redirects: list[str] = []
        current = url

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._timeout(url, redirects, timeout)

            try:
                async with asyncio.timeout(remaining):
                    await self._validate(current)
            except SSRFError:
                raise
            except TimeoutError:
                return self._timeout(url, redirects, timeout)
            except (OSError, ValueError) as exc:
                return FetchResult(
                    url=url,
                    redirects=tuple(redirects),
                    error=f"{type(exc).__name__}: {exc}",
                )

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._timeout(url, redirects, timeout)

            try:
                async with asyncio.timeout(remaining):
                    async with httpx.AsyncClient(
                        transport=self._transport,
                        timeout=remaining,
                        follow_redirects=False,
                        trust_env=False,
                        headers={"User-Agent": _USER_AGENT},
                    ) as client:
                        request = client.build_request("GET", current)
                        response = await client.send(request, stream=True)
                        try:
                            location = response.headers.get("location")
                            if response.status_code in _REDIRECT_STATUSES and location:
                                target = urljoin(str(response.url), location)
                                if len(redirects) >= self._max_redirects:
                                    raise self._blocked(
                                        current,
                                        f"more than {self._max_redirects} redirects",
                                    )
                                redirects.append(target)
                                current = target
                                continue

                            body, truncated = await self._read_body(response, max_bytes)
                            return FetchResult(
                                url=str(response.url),
                                status_code=response.status_code,
                                headers=dict(response.headers),
                                body=body,
                                truncated=truncated,
                                redirects=tuple(redirects),
                            )
                        finally:
                            await response.aclose()
            except SSRFError:
                raise
            except TimeoutError:
                return self._timeout(url, redirects, timeout)
            except (httpx.HTTPError, httpx.InvalidURL, OSError, ValueError) as exc:
                return FetchResult(
                    url=url,
                    redirects=tuple(redirects),
                    error=f"{type(exc).__name__}: {exc}",
                )

    def _timeout(self, url: str, redirects: list[str], timeout: float) -> FetchResult:
        return FetchResult(
            url=url,
            redirects=tuple(redirects),
            error=f"timed out after {timeout:g}s",
        )

    async def fetch_or_error(
        self,
        url: str,
        max_bytes: int = DEFAULT_MAX_BYTES,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> FetchResult:
        """Like :meth:`fetch`, but blocked URLs return an error result."""
        try:
            return await self.fetch(url, max_bytes=max_bytes, timeout=timeout)
        except SSRFError as exc:
            return exc.result
        except OSError as exc:  # pragma: no cover - defensive
            return FetchResult(url=url, error=f"{type(exc).__name__}: {exc}")

    async def _validate(self, url: str) -> None:
        try:
            await asyncio.to_thread(validate_url, url, resolver=self._resolver)
        except SSRFError as exc:
            self._record_block(url, exc.reason)
            raise

    async def _read_body(
        self, response: httpx.Response, max_bytes: int
    ) -> tuple[bytes, bool]:
        """Read at most `max_bytes` of the streamed body."""
        limit = max(0, max_bytes)
        body = bytearray()
        truncated = False
        async for chunk in response.aiter_bytes(_CHUNK_SIZE):
            remaining = limit - len(body)
            if remaining <= 0:
                truncated = True
                break
            if len(chunk) > remaining:
                body.extend(chunk[:remaining])
                truncated = True
                break
            body.extend(chunk)
        return bytes(body), truncated

    def _blocked(self, url: str, reason: str) -> SSRFError:
        self._record_block(url, reason)
        return SSRFError(f"{reason}: {url}", url=url)

    def _record_block(self, url: str, reason: str) -> None:
        if self._audit is None:
            return
        audited = redact_url(url)
        try:
            self._audit.record(
                None, "ssrf_blocked", audited, {"reason": reason, "source": "fetch"}
            )
        except Exception:
            logger.exception("audit: failed to record SSRF block for %s", audited)
