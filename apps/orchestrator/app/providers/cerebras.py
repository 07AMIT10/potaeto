from __future__ import annotations

import os

from app.providers.openai_compat import OpenAICompatibleProvider


class CerebrasProvider(OpenAICompatibleProvider):
    name = "cerebras"

    def __init__(self) -> None:
        api_key = os.environ.get("CEREBRAS_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("CEREBRAS_API_KEY not configured for orchestrator")

        base_url = os.environ.get("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1").strip()

        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_headers={"X-Cerebras-3rd-Party-Integration": "potaeto"},
        )
