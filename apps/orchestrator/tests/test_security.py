"""Security baseline: SSRF containment, rate limits, audit trail, admin guard.

Outbound fetches are exercised with an injected resolver and an
``httpx.MockTransport`` so the suite never touches the network.
"""

# pii-scan: allow-private-ip-file (SSRF fixtures use RFC1918/link-local literals)

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.audit import AuditLog
from app.db.repositories.audit import AuditRepo
from app.providers.base import StreamEvent
from app.security.ratelimit import RateLimiter
from app.security.ssrf import (
    FetchResult,
    SSRFError,
    SSRFSafeFetcher,
    is_blocked_ip,
    redact_url,
)
from app.tools.monitor import MonitorTools

PUBLIC_IP = "93.184.216.34"


def _resolver(host: str, port: int) -> list[str]:
    """Resolve every hostname in these tests to one public address."""
    return [PUBLIC_IP]


def _no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover
    raise AssertionError(f"unexpected network request to {request.url}")


def _fetcher(handler=_no_network, *, resolver=_resolver) -> SSRFSafeFetcher:
    return SSRFSafeFetcher(resolver=resolver, transport=httpx.MockTransport(handler))


def _set_rate_limits(client, **overrides) -> None:
    """Point the test app's settings at tighter budgets."""
    from dataclasses import replace

    client.app.state.settings = replace(client.app.state.settings, **overrides)


class _EchoProvider:
    name = "echo"

    async def stream_chat(self, request):
        yield StreamEvent.token("ok")
        yield StreamEvent.done("stop")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://172.16.4.2/",
        "http://192.168.0.10/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://0.0.0.0/",
        "http://224.0.0.1/",
        "http://[::ffff:127.0.0.1]/",
        "file:///etc/passwd",
        "ftp://example.com/file",
        "gopher://example.com/",
    ],
)
async def test_ssrf_blocks_private_targets(url):
    def resolver(host: str, port: int) -> list[str]:
        raise AssertionError("resolver must not be consulted for literals/schemes")

    with pytest.raises(SSRFError):
        await _fetcher(resolver=resolver).fetch(url)


@pytest.mark.parametrize(
    ("addresses", "hostname"),
    [
        (["127.0.0.1"], "localhost"),
        (["169.254.169.254"], "metadata.internal"),
        (["192.168.0.10"], "lan.local"),
        ([PUBLIC_IP, "10.0.0.7"], "mixed.example"),
    ],
)
async def test_ssrf_blocks_private_dns_answers(addresses, hostname):
    def resolver(host: str, port: int) -> list[str]:
        # A hostname with any private answer is refused wholesale.
        return addresses

    with pytest.raises(SSRFError):
        await _fetcher(resolver=resolver).fetch(f"https://{hostname}/")


async def test_redirect_to_private_is_blocked():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(302, headers={"Location": "http://127.0.0.1/"})

    fetcher = _fetcher(handler)
    with pytest.raises(SSRFError):
        await fetcher.fetch("https://example.com/redirect")
    assert calls == ["https://example.com/redirect"]


async def test_second_redirect_hop_to_private_is_blocked():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == "https://example.com/start":
            return httpx.Response(302, headers={"Location": "https://example.com/next"})
        return httpx.Response(302, headers={"Location": "http://127.0.0.1/secret"})

    with pytest.raises(SSRFError):
        await _fetcher(handler).fetch("https://example.com/start")
    # The second hop is validated before it is requested.
    assert calls == ["https://example.com/start", "https://example.com/next"]


async def test_redirect_to_file_scheme_is_blocked():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "file:///etc/passwd"})

    with pytest.raises(SSRFError):
        await _fetcher(handler).fetch("https://example.com/redirect")


async def test_redirect_limit_is_three():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            302, headers={"Location": f"https://example.com/hop{len(calls)}"}
        )

    with pytest.raises(SSRFError, match="redirect"):
        await _fetcher(handler).fetch("https://example.com/start")
    # The start request plus three followed redirects; the fourth is refused.
    assert len(calls) == 4


async def test_fetch_returns_result_for_allowed_target():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://example.com/hello"
        return httpx.Response(200, content=b"hello", headers={"X-Test": "1"})

    result = await _fetcher(handler).fetch("https://example.com/hello")
    assert isinstance(result, FetchResult)
    assert result.status_code == 200
    assert result.body == b"hello"
    assert result.truncated is False
    assert result.ok is True
    assert result.error is None


async def test_fetch_caps_response_bytes():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 100)

    result = await _fetcher(handler).fetch("https://example.com/big", max_bytes=10)
    assert result.body == b"x" * 10
    assert result.truncated is True


async def test_fetch_returns_error_result_for_network_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    result = await _fetcher(handler).fetch("https://example.com/down")
    assert result.ok is False
    assert result.status_code is None
    assert "ConnectError" in (result.error or "")


async def test_fetch_enforces_wall_clock_timeout():
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200)  # pragma: no cover - cancelled first

    result = await _fetcher(handler).fetch("https://example.com/slow", timeout=0.05)
    assert result.ok is False
    assert "timed out" in (result.error or "")


async def test_fetch_or_error_returns_blocked_result_without_raising():
    result = await SSRFSafeFetcher().fetch_or_error("http://127.0.0.1/")
    assert result.ok is False
    assert result.body == b""
    assert result.error


@pytest.mark.parametrize(
    "value",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.20.0.1",
        "192.168.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "not-an-ip",
    ],
)
def test_blocked_addresses(value):
    assert is_blocked_ip(value) is True


@pytest.mark.parametrize("value", ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
def test_public_addresses(value):
    assert is_blocked_ip(value) is False


def test_rate_limit_blocks_after_limit():
    rl = RateLimiter()
    assert rl.check("k", 2, 60)
    assert rl.check("k", 2, 60)
    assert not rl.check("k", 2, 60)


def test_rate_limit_refills_over_the_window():
    now = [1000.0]
    rl = RateLimiter(clock=lambda: now[0])
    assert rl.check("k", 2, 10)
    assert rl.check("k", 2, 10)
    assert not rl.check("k", 2, 10)
    now[0] += 5.0
    assert rl.check("k", 2, 10)
    assert not rl.check("k", 2, 10)


def test_rate_limit_keys_are_independent():
    rl = RateLimiter()
    assert rl.check("a", 1, 60)
    assert not rl.check("a", 1, 60)
    assert rl.check("b", 1, 60)


def test_rate_limit_rejects_non_positive_limits():
    rl = RateLimiter()
    assert not rl.check("k", 0, 60)
    assert not rl.check("k", 1, 0)


def test_audit_log_records_event(db):
    event = AuditLog(db).record(
        "device:1", "tool_call", "web_fetch", {"url": "https://example.com/"}
    )
    stored = AuditRepo(db).get(event.id)
    assert stored is not None
    assert stored.actor == "device:1"
    assert stored.kind == "tool_call"
    assert stored.subject == "web_fetch"
    assert stored.detail_json == {"url": "https://example.com/"}


def test_redact_url_drops_credentials_query_and_fragment():
    assert (
        redact_url("https://user:hunter2@10.0.0.1:8443/path?token=sekrit#frag")
        == "https://10.0.0.1:8443/path"
    )
    assert redact_url("http://[::1]:8080/x?y=z") == "http://[::1]:8080/x"


async def test_fetch_audit_redacts_credentials_and_query(db):
    fetcher = SSRFSafeFetcher(audit=AuditLog(db))
    with pytest.raises(SSRFError):
        await fetcher.fetch("https://user:hunter2@10.0.0.1/private?token=sekrit")

    events = AuditRepo(db).list(kind="ssrf_blocked", limit=10)
    assert len(events) == 1
    assert events[0].subject == "https://10.0.0.1/private"
    rendered = f"{events[0].subject} {events[0].detail_json}"
    assert "hunter2" not in rendered
    assert "sekrit" not in rendered


def test_monitor_audit_redacts_credentials_and_query(db):
    result = MonitorTools(db).http_ping(
        "https://user:hunter2@127.0.0.1/private?token=sekrit"
    )
    assert result["ok"] is False

    events = AuditRepo(db).list(kind="ssrf_blocked", limit=10)
    assert len(events) == 1
    assert events[0].subject == "https://127.0.0.1/private"
    rendered = f"{events[0].subject} {events[0].detail_json}"
    assert "hunter2" not in rendered
    assert "sekrit" not in rendered


def test_admin_guard_is_attached_to_the_router():
    from app.api.admin import require_admin
    from app.api.admin import router as admin_router

    assert any(
        getattr(dep, "dependency", None) is require_admin
        for dep in admin_router.dependencies
    )
    # FastAPI folds router dependencies into every route, so future routes
    # inherit the guard instead of trusting each author to repeat it.
    assert all(
        any(
            getattr(dep, "dependency", None) is require_admin
            for dep in route.dependencies
        )
        for route in admin_router.routes
    )


def test_admin_disabled_without_secret(client, monkeypatch):
    monkeypatch.delenv("ADMIN_SECRET", raising=False)
    response = client.get("/v1/admin/anything")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "unavailable"
    # The catch-all also covers the bare prefix with a trailing slash.
    assert client.get("/v1/admin/").status_code == 503


def test_admin_requires_matching_secret(client, monkeypatch):
    monkeypatch.setenv("ADMIN_SECRET", "s3cret")
    assert client.get("/v1/admin/anything").status_code == 401
    assert (
        client.get(
            "/v1/admin/anything", headers={"X-Admin-Secret": "wrong"}
        ).status_code
        == 401
    )
    # Authenticated but Release 1 ships no admin endpoints.
    assert (
        client.get(
            "/v1/admin/anything", headers={"X-Admin-Secret": "s3cret"}
        ).status_code
        == 404
    )


def test_admin_failures_are_audited(client, api_db, monkeypatch):
    monkeypatch.delenv("ADMIN_SECRET", raising=False)
    client.get("/v1/admin/disabled")
    monkeypatch.setenv("ADMIN_SECRET", "s3cret")
    client.get("/v1/admin/forbidden", headers={"X-Admin-Secret": "nope"})

    kinds = {event.kind for event in AuditRepo(api_db).list(limit=50)}
    assert "admin_disabled" in kinds
    assert "auth_failed" in kinds


def test_device_auth_failures_are_audited(client, api_db):
    response = client.get(
        "/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert response.status_code == 401
    events = AuditRepo(api_db).list(kind="auth_failed", limit=10)
    assert any(event.subject == "/v1/auth/me" for event in events)
    assert all("not-a-real-token" not in str(event.detail_json) for event in events)


def test_monitor_ping_blocks_private_targets(db):
    result = MonitorTools(db).http_ping("http://127.0.0.1:8080/")
    assert result["status"] is None
    assert result["ok"] is False
    assert "blocked" in (result["error"] or "").lower() or "SSRF" in (
        result["error"] or ""
    )


def test_monitor_ping_audits_ssrf_blocks(db):
    MonitorTools(db).http_ping("http://169.254.169.254/latest/meta-data/")
    events = AuditRepo(db).list(kind="ssrf_blocked", limit=10)
    assert events
    assert events[0].subject == "http://169.254.169.254/latest/meta-data/"


def test_rate_limit_settings_read_from_env(monkeypatch):
    from app.config import Settings, get_settings

    assert Settings().rate_limit_pair_per_min == 10
    assert Settings().rate_limit_chat_per_min == 30

    monkeypatch.setenv("RATE_LIMIT_PAIR_PER_MIN", "3")
    monkeypatch.setenv("RATE_LIMIT_CHAT_PER_MIN", "7")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.rate_limit_pair_per_min == 3
        assert settings.rate_limit_chat_per_min == 7
    finally:
        get_settings.cache_clear()


def test_pair_rate_limit_returns_429(client):
    _set_rate_limits(client, rate_limit_pair_per_min=2)
    payload = {"code": "not-a-code", "device_name": "probe"}

    # Invalid codes keep the uniform 401 until the budget is spent.
    assert client.post("/v1/auth/pair", json=payload).status_code == 401
    assert client.post("/v1/auth/pair", json=payload).status_code == 401

    exceeded = client.post("/v1/auth/pair", json=payload)
    assert exceeded.status_code == 429
    assert exceeded.headers["retry-after"] == "60"
    body = exceeded.json()
    assert body["error"]["code"] == "rate_limited"
    assert body["error"]["message"]


def test_pair_rate_limit_is_per_client_ip(client):
    from fastapi.testclient import TestClient

    _set_rate_limits(client, rate_limit_pair_per_min=1)
    payload = {"code": "not-a-code", "device_name": "probe"}

    assert client.post("/v1/auth/pair", json=payload).status_code == 401
    assert client.post("/v1/auth/pair", json=payload).status_code == 429

    # A different caller IP has its own bucket and is not throttled.
    other = TestClient(client.app, client=("203.0.113.9", 1234))
    try:
        assert other.post("/v1/auth/pair", json=payload).status_code == 401
    finally:
        other.close()


def test_chat_rate_limit_returns_429(client, paired_device, api_db):
    from app.db.repositories.conversations import ConversationRepo
    from app.providers.registry import ProviderRegistry

    registry = ProviderRegistry()
    registry.register(_EchoProvider())
    client.app.state.providers = registry
    client.app.state.model = "test-model"
    _set_rate_limits(client, rate_limit_chat_per_min=2)

    conv = ConversationRepo(api_db).ensure_conversation(paired_device.user_id, "e1")
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    payload = {"conversation_id": conv.id, "message": "hello"}

    assert (
        client.post("/v1/chat/stream", json=payload, headers=headers).status_code == 200
    )
    assert (
        client.post("/v1/chat/stream", json=payload, headers=headers).status_code == 200
    )

    exceeded = client.post("/v1/chat/stream", json=payload, headers=headers)
    assert exceeded.status_code == 429
    assert exceeded.headers["retry-after"] == "60"
    assert exceeded.json()["error"]["code"] == "rate_limited"


def _request(peer: str | None, headers: dict[str, str]):
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [
            (name.lower().encode(), value.encode()) for name, value in headers.items()
        ],
        "client": (peer, 1234) if peer else None,
        "server": ("testserver", 80),
        "scheme": "http",
        "query_string": b"",
    }
    return Request(scope)


def test_client_ip_trust_rules():
    from app.api.rate_limit import client_ip

    assert (
        client_ip(_request("127.0.0.1", {"X-Forwarded-For": "1.2.3.4, 10.0.0.1"}))
        == "1.2.3.4"
    )
    assert (
        client_ip(_request("::1", {"CF-Connecting-IP": "2001:0db8::1"}))
        == "2001:db8::1"
    )
    # A non-loopback peer wins over a spoofed header.
    assert (
        client_ip(_request("203.0.113.7", {"X-Forwarded-For": "1.2.3.4"}))
        == "203.0.113.7"
    )
    assert client_ip(_request("127.0.0.1", {})) == "127.0.0.1"
    assert client_ip(_request("127.0.0.1", {"X-Forwarded-For": "garbage"})) == "unknown"
    assert client_ip(_request(None, {})) == "unknown"


def test_pair_rate_limit_uses_forwarded_ip_from_loopback(client):
    from fastapi.testclient import TestClient

    _set_rate_limits(client, rate_limit_pair_per_min=1)
    payload = {"code": "not-a-code", "device_name": "probe"}
    first_ip = TestClient(client.app, client=("127.0.0.1", 1234))
    second_ip = TestClient(client.app, client=("127.0.0.1", 1234))
    try:
        first = first_ip.post(
            "/v1/auth/pair",
            json=payload,
            headers={"X-Forwarded-For": "1.2.3.4"},
        )
        assert first.status_code == 401

        # A different forwarded address gets its own bucket.
        other = second_ip.post(
            "/v1/auth/pair",
            json=payload,
            headers={"X-Forwarded-For": "5.6.7.8"},
        )
        assert other.status_code == 401

        # The first forwarded address is throttled.
        exceeded = first_ip.post(
            "/v1/auth/pair",
            json=payload,
            headers={"X-Forwarded-For": "1.2.3.4"},
        )
        assert exceeded.status_code == 429
    finally:
        first_ip.close()
        second_ip.close()


def test_pair_rate_limit_ignores_forwarded_ip_from_remote_peer(client):
    from fastapi.testclient import TestClient

    _set_rate_limits(client, rate_limit_pair_per_min=1)
    payload = {"code": "not-a-code", "device_name": "probe"}
    remote = TestClient(client.app, client=("203.0.113.7", 1234))
    try:
        assert (
            remote.post(
                "/v1/auth/pair",
                json=payload,
                headers={"X-Forwarded-For": "1.2.3.4"},
            ).status_code
            == 401
        )
        # Spoofing a new forwarded address must not escape the peer's bucket.
        assert (
            remote.post(
                "/v1/auth/pair",
                json=payload,
                headers={"X-Forwarded-For": "5.6.7.8"},
            ).status_code
            == 429
        )
    finally:
        remote.close()


def test_pair_rate_limit_falls_back_to_loopback_peer(client):
    from fastapi.testclient import TestClient

    _set_rate_limits(client, rate_limit_pair_per_min=1)
    payload = {"code": "not-a-code", "device_name": "probe"}
    loopback = TestClient(client.app, client=("127.0.0.1", 1234))
    try:
        assert loopback.post("/v1/auth/pair", json=payload).status_code == 401
        assert loopback.post("/v1/auth/pair", json=payload).status_code == 429
    finally:
        loopback.close()
