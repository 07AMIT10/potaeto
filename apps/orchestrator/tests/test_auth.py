import re

import pytest

from app.auth.tokens import hash_token


def test_pairing_code_is_one_time(db):
    from app.auth.pairing import PairingError, PairingService

    svc = PairingService(db)
    code = svc.create_code("u1")
    first = svc.exchange(code, "phone")
    assert first.token
    with pytest.raises(PairingError):
        svc.exchange(code, "laptop")


def test_pairing_code_is_128_bits_and_one_time(db):
    from app.auth.pairing import PairingError, PairingService

    svc = PairingService(db)
    code = svc.create_code("u1")
    assert re.fullmatch(r"[0-9a-f]{32}", code)
    svc.exchange(code, "phone")
    with pytest.raises(PairingError):
        svc.exchange(code, "phone")


def test_pairing_code_expires(db):
    from app.auth.pairing import PairingError, PairingService

    svc = PairingService(db)
    code = svc.create_code("u1", ttl_sec=-1)
    with pytest.raises(PairingError):
        svc.exchange(code, "phone")


def test_token_is_stored_hashed(db):
    from app.auth.pairing import PairingService

    svc = PairingService(db)
    result = svc.exchange(svc.create_code("u1"), "phone")
    row = db.execute("SELECT token_hash FROM devices WHERE id=?", (result.device_id,)).fetchone()
    assert row["token_hash"] != result.token
    assert row["token_hash"] == hash_token(result.token)


def test_protected_endpoint_rejects_missing_token(client):
    assert client.get("/v1/auth/me").status_code == 401


def test_protected_endpoint_accepts_valid_token(client, paired_device):
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {paired_device.token}"})
    assert r.status_code == 200
    assert r.json()["device_id"] == paired_device.device_id


def test_pair_endpoint_exchanges_code(client, api_db):
    from app.auth.pairing import PairingService
    from app.db.repositories.users import UserRepo

    UserRepo(api_db).create(name="u1", user_id="u1")
    code = PairingService(api_db).create_code("u1")
    r = client.post("/v1/auth/pair", json={"code": code, "device_name": "phone"})
    assert r.status_code == 200
    body = r.json()
    assert body["user_id"] == "u1"
    assert body["token"]

    me = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["device_id"] == body["device_id"]


def test_pair_endpoint_hides_unknown_code(client):
    r = client.post("/v1/auth/pair", json={"code": "deadbeef", "device_name": "phone"})
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid or expired pairing code"


def test_revoked_device_token_is_rejected(client, paired_device, api_db):
    api_db.execute(
        "UPDATE devices SET revoked_at = datetime('now') WHERE id = ?",
        (paired_device.device_id,),
    )
    api_db.commit()
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {paired_device.token}"})
    assert r.status_code == 401


# ── HttpOnly device cookie (PWA auth) ─────────────────────────────────────


def test_pair_endpoint_sets_http_only_cookie(client, api_db):
    from app.auth.pairing import PairingService
    from app.db.repositories.users import UserRepo

    UserRepo(api_db).create(name="u1", user_id="u1")
    code = PairingService(api_db).create_code("u1")
    r = client.post("/v1/auth/pair", json={"code": code, "device_name": "phone"})
    assert r.status_code == 200
    set_cookie = r.headers.get("set-cookie", "")
    assert "potaeto_device=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
    assert "Path=/" in set_cookie
    assert "Max-Age=2592000" in set_cookie
    # Dev default: not Secure.
    assert "Secure" not in set_cookie


def test_pair_then_cookie_authenticates(client, api_db):
    from app.auth.pairing import PairingService
    from app.db.repositories.users import UserRepo

    UserRepo(api_db).create(name="u1", user_id="u1")
    code = PairingService(api_db).create_code("u1")
    paired = client.post("/v1/auth/pair", json={"code": code, "device_name": "phone"})
    assert paired.status_code == 200

    # No Authorization header: the cookie jar supplies the device identity.
    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["device_id"] == paired.json()["device_id"]


def test_protected_endpoint_accepts_cookie(client, paired_device):
    client.cookies.set("potaeto_device", paired_device.token)
    r = client.get("/v1/auth/me")
    assert r.status_code == 200
    assert r.json()["device_id"] == paired_device.device_id


def test_cookie_secure_defaults_true_and_env_can_opt_out(monkeypatch):
    """`Secure` is a Python setting, not Node's NODE_ENV (which Python never sets)."""
    from app.config import Settings, get_settings

    assert Settings().cookie_secure is True

    monkeypatch.setenv("POTAETO_COOKIE_SECURE", "0")
    get_settings.cache_clear()
    try:
        assert get_settings().cookie_secure is False
    finally:
        get_settings.cache_clear()


def test_pair_cookie_is_secure_when_configured(api_db):
    from fastapi.testclient import TestClient

    from app.auth.pairing import PairingService
    from app.config import Settings
    from app.db.repositories.users import UserRepo
    from app.main import create_app

    app = create_app(Settings(db_path=":memory:", cookie_secure=True))
    with TestClient(app) as secure_client:
        UserRepo(app.state.db).create(name="u1", user_id="u1")
        code = PairingService(app.state.db).create_code("u1")
        r = secure_client.post(
            "/v1/auth/pair", json={"code": code, "device_name": "phone"}
        )
        assert r.status_code == 200
        assert "Secure" in r.headers.get("set-cookie", "")


def test_cors_allows_dev_origin_with_credentials(client):
    r = client.options(
        "/v1/health",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert r.headers.get("access-control-allow-credentials") == "true"
