"""Provider registry built from core settings.

Release 1 registers OpenCode Go and OpenRouter (in that order) and resolves the
configured model against their live catalogs. The first provider that actually
lists ``POTAETO_MODEL`` wins; a provider that cannot be reached stays in the
candidate list as a last resort, so a transient catalog outage never makes the
agent unusable. :class:`FailoverProvider` retries the next candidate when a
provider fails before emitting its first token.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from app.providers.base import ChatProvider, ChatRequest, ModelInfo, StreamEvent

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProviderChoice:
    """One provider plus the catalog entry for the requested model, if known."""

    provider: ChatProvider
    model: ModelInfo | None = None

    @property
    def name(self) -> str:
        return self.provider.name


class FailoverProvider:
    """Try each candidate in order, failing over only before the first token.

    Once a provider has streamed a token the turn is committed to it: switching
    mid-answer would duplicate or splice text. An error before any token is
    safe to retry with the next configured provider. If every candidate fails,
    the last error event is yielded, preserving the existing SSE semantics.
    """

    name = "failover"

    def __init__(self, choices: list[ProviderChoice]) -> None:
        if not choices:
            raise ValueError("FailoverProvider requires at least one provider")
        self._choices = list(choices)
        self.last_name = self._choices[0].name

    def stream_chat(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        return self._stream_with_failover(request)

    async def _stream_with_failover(
        self, request: ChatRequest
    ) -> AsyncIterator[StreamEvent]:
        last_error: StreamEvent | None = None
        for choice in self._choices:
            provider = choice.provider
            self.last_name = provider.name
            emitted = False
            failure: StreamEvent | None = None
            try:
                async for event in provider.stream_chat(request):
                    if event.type == "error":
                        failure = event
                        break
                    if event.type in ("token", "tool_call_delta"):
                        emitted = True
                    yield event
            except Exception as exc:  # noqa: BLE001 - retry the next provider
                failure = StreamEvent.error(
                    "provider_error", f"{type(exc).__name__}: {exc}"
                )

            if failure is None:
                return
            if emitted:
                # The client has already received partial output; surfacing the
                # error is safer than silently restarting on another model.
                yield failure
                return
            last_error = failure
            logger.warning(
                "provider %s failed before first token (%s); trying next provider",
                provider.name,
                failure.code or failure.message,
            )

        if last_error is not None:
            yield last_error
        else:  # pragma: no cover - unreachable when choices is non-empty
            yield StreamEvent.error("no_provider", "no provider configured")


class ProviderRegistry:
    """A name -> provider map assembled from ``Settings``.

    Release 1 registers the two streaming providers (OpenCode Go and OpenRouter)
    when their API keys are configured; the legacy adapters remain behind the
    old model router.
    """

    def __init__(self) -> None:
        self._providers: dict[str, ChatProvider] = {}

    @classmethod
    def from_settings(cls, settings: Any) -> ProviderRegistry:
        registry = cls()
        opencode_key = getattr(getattr(settings, "opencode", None), "api_key", "") or ""
        if opencode_key:
            from app.providers.opencode_go import OpenCodeGoProvider

            opencode = settings.opencode
            registry.register(
                OpenCodeGoProvider(
                    api_key=opencode.api_key,
                    session_id=opencode.session_id or None,
                    base_url=opencode.base_url or None,
                )
            )

        openrouter_key = (
            getattr(getattr(settings, "openrouter", None), "api_key", "") or ""
        )
        if openrouter_key:
            from app.providers.openrouter import OpenRouterProvider

            openrouter = settings.openrouter
            registry.register(
                OpenRouterProvider(
                    api_key=openrouter.api_key,
                    base_url=openrouter.base_url or None,
                    http_referer=openrouter.http_referer or None,
                    app_title=openrouter.app_title or None,
                )
            )

        # Test-only offline provider for scripts/smoke.sh. Registered last so a
        # real provider always wins when both are configured.
        if getattr(settings, "smoke_provider", False):
            from app.providers.smoke import SmokeProvider

            registry.register(SmokeProvider())
        return registry

    def register(self, provider: ChatProvider) -> None:
        self._providers[provider.name] = provider

    def get(self, name: str) -> ChatProvider | None:
        return self._providers.get(name)

    def names(self) -> list[str]:
        return list(self._providers.keys())

    async def list_models(self) -> dict[str, list[ModelInfo]]:
        return {
            name: await provider.list_models()
            for name, provider in self._providers.items()
        }

    def stream_chat(
        self, name: str, request: ChatRequest
    ) -> AsyncIterator[StreamEvent]:
        provider = self._providers.get(name)
        if provider is None:
            raise KeyError(f"Unknown provider: {name}")
        return provider.stream_chat(request)

    def _ordered(self, preferred: str | None) -> list[ChatProvider]:
        names = list(self._providers)
        if preferred and preferred in self._providers:
            names.remove(preferred)
            names.insert(0, preferred)
        return [self._providers[name] for name in names]

    async def select(
        self, model: str, preferred: str | None = None
    ) -> list[ProviderChoice]:
        """Resolve ``model`` against each provider catalog, best match first.

        Providers that list the model come first (in preferred/registration
        order), followed by providers whose catalog was unavailable or does not
        list it. The latter remain candidates because a stale/failed catalog
        must not strand the agent; a warning records why they were demoted.
        """
        ordered = self._ordered(preferred)
        if preferred and preferred not in self._providers:
            logger.warning(
                "provider %r is not configured; using registration order", preferred
            )
        matched: list[ProviderChoice] = []
        unmatched: list[ProviderChoice] = []
        for provider in ordered:
            try:
                models = await provider.list_models()
            except Exception as exc:  # noqa: BLE001 - catalog failure is non-fatal
                logger.warning(
                    "provider %s catalog unavailable (%s: %s); keeping as fallback",
                    provider.name,
                    type(exc).__name__,
                    exc,
                )
                unmatched.append(ProviderChoice(provider, None))
                continue
            info = next((entry for entry in models if entry.id == model), None)
            if info is None:
                logger.warning(
                    "model %r is absent from provider %s's catalog; trying the next provider",
                    model,
                    provider.name,
                )
                unmatched.append(ProviderChoice(provider, None))
            else:
                matched.append(ProviderChoice(provider, info))
        return matched + unmatched


def build_provider(choices: list[ProviderChoice]) -> ChatProvider:
    """Return a single provider or a failover chain for the selected choices."""
    if not choices:
        raise ValueError("no provider choices")
    if len(choices) == 1:
        return choices[0].provider
    return FailoverProvider(choices)


def first_model_info(choices: list[ProviderChoice]) -> ModelInfo | None:
    """Return the catalog entry for the first provider that has one."""
    return next((choice.model for choice in choices if choice.model is not None), None)
