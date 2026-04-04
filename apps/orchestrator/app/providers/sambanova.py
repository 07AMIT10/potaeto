from __future__ import annotations

import os

from app.providers.openai_compat import OpenAICompatibleProvider


class SambaNovaProvider(OpenAICompatibleProvider):
    name = "sambanova"

    def __init__(self) -> None:
        api_key = os.environ.get("SAMBANOVA_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("SAMBANOVA_API_KEY not configured for orchestrator")

        base_url = os.environ.get("SAMBANOVA_BASE_URL", "https://api.sambanova.ai/v1").strip()

        super().__init__(
            api_key=api_key,
            base_url=base_url,
        )
