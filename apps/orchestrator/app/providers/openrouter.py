from __future__ import annotations

import os

from app.providers.openai_compat import OpenAICompatibleProvider


class OpenRouterProvider(OpenAICompatibleProvider):
    name = "openrouter"

    def __init__(self) -> None:
        api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY not configured for orchestrator")

        base_url = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
        referer = os.environ.get("OPENROUTER_HTTP_REFERER", "").strip()
        app_title = os.environ.get("OPENROUTER_APP_TITLE", "Potaeto").strip()

        headers: dict[str, str] = {}
        if referer:
            headers["HTTP-Referer"] = referer
        if app_title:
            headers["X-OpenRouter-Title"] = app_title

        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_headers=headers,
        )
