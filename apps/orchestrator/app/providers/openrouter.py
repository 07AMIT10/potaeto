"""OpenRouter provider.

Keeps the legacy no-arg, env-driven ``OpenRouterProvider()`` (still a
``generate_text``/``generate_text_stream`` adapter via ``OpenAICompatibleProvider``)
while adding the streaming catalog interface: ``list_models`` (public discovery,
24 h cache with ETag and stale-serving) and ``stream_chat`` (OpenAI-compatible
SSE with the extra usage chunk and mid-stream error handling).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import httpx

from app.catalog import normalize
from app.catalog.cache import CatalogCache
from app.providers.base import ChatRequest, ModelInfo, StreamEvent
from app.providers.openai_compat import (
    OpenAICompatibleProvider,
    build_chat_payload,
    stream_openai_chat,
)

MODELS_TTL_SEC = 24 * 60 * 60
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_APP_TITLE = "Potaeto"


class OpenRouterProvider(OpenAICompatibleProvider):
    name = "openrouter"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        http_referer: str | None = None,
        app_title: str | None = None,
        client: httpx.AsyncClient | None = None,
        cache: CatalogCache | None = None,
        timeout_sec: float = 60.0,
    ) -> None:
        api_key = (api_key or os.environ.get("OPENROUTER_API_KEY", "")).strip()
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY not configured for orchestrator")

        base_url = (
            base_url or os.environ.get("OPENROUTER_BASE_URL", DEFAULT_BASE_URL)
        ).strip()
        referer = (
            http_referer
            if http_referer is not None
            else os.environ.get("OPENROUTER_HTTP_REFERER", "")
        ).strip()
        title = (
            app_title or os.environ.get("OPENROUTER_APP_TITLE", DEFAULT_APP_TITLE)
        ).strip()

        headers: dict[str, str] = {}
        if referer:
            headers["HTTP-Referer"] = referer
        if title:
            headers["X-OpenRouter-Title"] = title

        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_headers=headers,
            timeout_sec=timeout_sec,
        )

        self._client = client or httpx.AsyncClient(timeout=timeout_sec)
        self._owns_client = client is None
        self._cache = cache or CatalogCache()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def list_models(self) -> list[ModelInfo]:
        cached = self._cache.get(self.name)
        if cached is not None:
            return cached

        etag = self._cache.get_etag(self.name)
        headers = {"If-None-Match": etag} if etag else {}
        try:
            response = await self._client.get(
                f"{self._base_url}/models", headers=headers
            )
        except httpx.HTTPError:
            return self._cache.get_stale(self.name) or []

        if response.status_code == 304:
            stale = self._cache.get_stale(self.name)
            if stale is not None:
                self._cache.set(self.name, stale, MODELS_TTL_SEC, etag)
                return stale
            return []

        if response.status_code != 200:
            return self._cache.get_stale(self.name) or []

        try:
            body = response.json()
        except ValueError:
            return self._cache.get_stale(self.name) or []

        models = (
            normalize.normalize_openrouter_models(body)
            if isinstance(body, dict)
            else []
        )
        new_etag = response.headers.get("etag") or etag
        self._cache.set(self.name, models, MODELS_TTL_SEC, new_etag)
        return models

    def stream_chat(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        payload = build_chat_payload(request, stream=True)
        url = f"{self._base_url}/chat/completions"
        return stream_openai_chat(self._client, url, self._headers(), payload)
