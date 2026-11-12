"""Offline provider used only by the deployment smoke test.

``scripts/smoke.sh`` starts a temporary core with ``POTAETO_SMOKE_PROVIDER=1``
so the chat check never calls a real model or needs an API key. Registration is
gated in :class:`app.providers.registry.ProviderRegistry`; leaving the env var
unset (the production default) changes nothing.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.providers.base import ChatRequest, ModelInfo, StreamEvent

SMOKE_MODEL_ID = "smoke-model"


class SmokeProvider:
    """A deterministic provider that streams a fixed reply and ``done``."""

    name = "smoke"

    async def list_models(self) -> list[ModelInfo]:
        return [ModelInfo(provider=self.name, id=SMOKE_MODEL_ID, name="Smoke test")]

    async def stream_chat(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        yield StreamEvent.token("smoke: ")
        yield StreamEvent.token("hello from the offline provider")
        yield StreamEvent.done("stop")
