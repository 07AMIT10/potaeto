from __future__ import annotations

import pytest
from app.catalog.cache import CatalogCache
from app.db.repositories.usage import UsageRepo
from app.providers.base import ModelInfo


def test_models_usage_requires_authentication(client):
    """GET /v1/models/usage must require device authentication."""
    response = client.get("/v1/models/usage")
    assert response.status_code == 401


def test_models_usage_empty(client, paired_device):
    """When no provider usage has been recorded, return zeroed aggregate stats."""
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    response = client.get("/v1/models/usage", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["total_tokens_in"] == 0
    assert data["total_tokens_out"] == 0
    assert data["total_cost"] == 0.0
    assert data["call_count"] == 0
    assert data["by_provider"] == {}
    assert data["by_model"] == {}


def test_models_usage_aggregates(client, paired_device, api_db):
    """Verifies totals, per-provider, and per-model aggregates."""
    repo = UsageRepo(api_db)
    # Record some usage entries with neutral mock names
    repo.record(
        provider="provider_alpha",
        model_id="model_fast",
        tokens_in=100,
        tokens_out=50,
        cost=0.0015,
        success=True,
    )
    repo.record(
        provider="provider_alpha",
        model_id="model_fast",
        tokens_in=200,
        tokens_out=80,
        cost=0.0028,
        success=True,
    )
    repo.record(
        provider="provider_beta",
        model_id="model_deep",
        tokens_in=500,
        tokens_out=250,
        cost=0.0150,
        success=True,
    )

    headers = {"Authorization": f"Bearer {paired_device.token}"}
    response = client.get("/v1/models/usage", headers=headers)
    assert response.status_code == 200
    data = response.json()

    assert data["total_tokens_in"] == 800
    assert data["total_tokens_out"] == 380
    assert data["total_cost"] == pytest.approx(0.0193, abs=1e-5)
    assert data["call_count"] == 3

    # Check by_provider
    alpha_stat = data["by_provider"]["provider_alpha"]
    assert alpha_stat["tokens_in"] == 300
    assert alpha_stat["tokens_out"] == 130
    assert alpha_stat["cost"] == pytest.approx(0.0043, abs=1e-5)
    assert alpha_stat["call_count"] == 2

    beta_stat = data["by_provider"]["provider_beta"]
    assert beta_stat["tokens_in"] == 500
    assert beta_stat["tokens_out"] == 250
    assert beta_stat["cost"] == pytest.approx(0.0150, abs=1e-5)
    assert beta_stat["call_count"] == 1

    # Check by_model
    fast_stat = data["by_model"]["model_fast"]
    assert fast_stat["tokens_in"] == 300
    assert fast_stat["tokens_out"] == 130
    assert fast_stat["cost"] == pytest.approx(0.0043, abs=1e-5)
    assert fast_stat["call_count"] == 2

    deep_stat = data["by_model"]["model_deep"]
    assert deep_stat["tokens_in"] == 500
    assert deep_stat["tokens_out"] == 250
    assert deep_stat["cost"] == pytest.approx(0.0150, abs=1e-5)
    assert deep_stat["call_count"] == 1


@pytest.mark.asyncio
async def test_catalog_cache_stale_while_error(db):
    """When refreshing a provider catalog fails, cache returns stale entries."""
    cache = CatalogCache(db=db)
    cached_models = [ModelInfo(provider="provider_x", id="model_x")]
    cache.set("provider_x", cached_models, ttl_sec=3600)

    # 1. Failing async fetcher (e.g. 503 / 429 / timeout)
    async def failing_fetcher():
        raise RuntimeError("upstream 503 Service Unavailable")

    result = await cache.refresh("provider_x", failing_fetcher)
    assert len(result) == 1
    assert result[0].id == "model_x"

    # 2. Failing sync fetcher
    def failing_sync():
        raise TimeoutError("connection timed out")

    result_sync = cache.refresh_sync("provider_x", failing_sync)
    assert len(result_sync) == 1
    assert result_sync[0].id == "model_x"


def test_models_endpoint_stale_while_error(client, paired_device, api_db):
    """GET /v1/models serves stale entries when a registered provider fails."""
    from app.providers.registry import ProviderRegistry

    # Pre-populate SQLite catalog cache with existing models
    cache = CatalogCache(db=api_db)
    cache.set(
        "flaky_provider",
        [ModelInfo(provider="flaky_provider", id="cached_model_1", name="Cached Model")],
        ttl_sec=3600,
    )

    class FlakyProvider:
        name = "flaky_provider"

        async def list_models(self):
            raise ConnectionError("503 Upstream Provider Down")

    registry = ProviderRegistry()
    registry.register(FlakyProvider())
    client.app.state.providers = registry

    headers = {"Authorization": f"Bearer {paired_device.token}"}
    response = client.get("/v1/models", headers=headers)
    assert response.status_code == 200
    body = response.json()
    model_ids = [m["id"] for m in body["models"]]
    assert "cached_model_1" in model_ids
