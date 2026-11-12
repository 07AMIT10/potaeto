"""The smoke-only provider is offline, deterministic, and opt-in."""

from app.config import Settings
from app.providers.base import ChatRequest
from app.providers.registry import ProviderRegistry
from app.providers.smoke import SmokeProvider


def test_smoke_provider_is_not_registered_by_default():
    registry = ProviderRegistry.from_settings(Settings())

    assert registry.names() == []


def test_smoke_provider_registers_only_when_enabled():
    registry = ProviderRegistry.from_settings(Settings(smoke_provider=True))

    assert registry.names() == ["smoke"]
    assert isinstance(registry.get("smoke"), SmokeProvider)


async def test_smoke_provider_streams_token_and_done():
    provider = SmokeProvider()
    events = [
        event
        async for event in provider.stream_chat(
            ChatRequest(model="smoke-model", messages=[])
        )
    ]

    assert [event.type for event in events] == ["token", "token", "done"]
    assert "smoke" in "".join(event.text or "" for event in events)
    assert events[-1].finish_reason == "stop"


async def test_smoke_provider_lists_its_model():
    models = await SmokeProvider().list_models()

    assert [model.id for model in models] == ["smoke-model"]
