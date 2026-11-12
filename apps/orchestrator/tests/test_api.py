def test_health_is_public(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_health_reports_db_and_version(client):
    body = client.get("/v1/health").json()
    assert body["db"] == "ok"
    assert body["version"]
    assert body["uptime_sec"] >= 0


def test_unknown_route_returns_json_error(client):
    r = client.get("/v1/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_http_errors_use_json_envelope(client):
    r = client.get("/v1/auth/me")
    assert r.status_code == 401
    body = r.json()
    assert body["error"]["code"] == "unauthorized"
    # Task 3's auth client still reads the legacy detail field.
    assert body["detail"]


def test_interactive_docs_and_schema_are_disabled(client):
    """Release 1 authenticates every endpoint except pairing/health."""
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


class _CatalogProvider:
    name = "fake"

    async def list_models(self):
        from app.providers.base import ModelInfo

        return [
            ModelInfo(
                provider="fake",
                id="model-a",
                name="Model A",
                context_length=128000,
                max_output_tokens=4096,
                supports_tools=True,
                pricing={"input": 0.1},
                retention="zero",
            )
        ]

    async def stream_chat(self, request):  # pragma: no cover - catalog tests only
        if False:
            yield None


def _use_catalog_provider(client):
    from app.providers.registry import ProviderRegistry

    registry = ProviderRegistry()
    registry.register(_CatalogProvider())
    client.app.state.providers = registry
    client.app.state.model = "model-a"


def test_model_catalog_requires_auth(client):
    assert client.get("/v1/models").status_code == 401


def test_model_catalog_exposes_capabilities_without_keys(client, paired_device):
    _use_catalog_provider(client)
    headers = {"Authorization": f"Bearer {paired_device.token}"}

    response = client.get("/v1/models", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["active_model"] == "model-a"
    model = body["models"][0]
    assert model["provider"] == "fake"
    assert model["context_length"] == 128000
    assert model["supports_tools"] is True
    assert model["retention"] == "zero"
    assert model["pricing"] == {"input": 0.1}
    assert "api_key" not in response.text


def test_model_picker_persists_and_applies_the_choice(client, paired_device, api_db):
    _use_catalog_provider(client)
    headers = {"Authorization": f"Bearer {paired_device.token}"}

    response = client.post(
        "/v1/models/active",
        json={"model": "model-b", "provider": "fake"},
        headers=headers,
    )
    assert response.status_code == 200
    assert client.app.state.model == "model-b"

    row = api_db.execute(
        "SELECT value_json FROM settings WHERE key = 'active_model'"
    ).fetchone()
    assert "model-b" in row["value_json"]


def test_model_picker_rejects_an_unknown_provider(client, paired_device):
    _use_catalog_provider(client)
    response = client.post(
        "/v1/models/active",
        json={"model": "model-b", "provider": "nope"},
        headers={"Authorization": f"Bearer {paired_device.token}"},
    )
    assert response.status_code == 400
