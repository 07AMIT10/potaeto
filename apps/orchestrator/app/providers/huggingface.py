from __future__ import annotations

import os
from typing import Any

from huggingface_hub import InferenceClient  # type: ignore

from app.providers.base import Provider, TextRequest, TextResponse


class HuggingFaceProvider(Provider):
    name = "huggingface"

    def __init__(self) -> None:
        base_url = os.environ.get("HF_INFERENCE_BASE_URL")
        api_key = os.environ.get("HF_API_KEY") or os.environ.get("HUGGINGFACE_API_TOKEN")

        if not base_url:
            raise RuntimeError("HF_INFERENCE_BASE_URL not configured for orchestrator")

        # api_key may be optional for some local deployments; we still pass it if present.
        self._client = InferenceClient(base_url=base_url, api_key=api_key or None)

    async def generate_text(self, request: TextRequest) -> TextResponse:
        # Flatten chat-style messages into OpenAI-compatible messages for chat.completions
        messages: list[dict[str, Any]] = [
            {
                "role": "assistant" if m.role == "assistant" else m.role,
                "content": m.content,
            }
            for m in request.messages
        ]

        completion = self._client.chat.completions.create(
            model=request.model_key,
            messages=messages,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )

        choice = completion.choices[0]
        # choice.message.content may be a string or a list of chunks; normalize to string.
        content = getattr(choice.message, "content", "") or ""
        if isinstance(content, list):
            content = "".join(
                part if isinstance(part, str) else getattr(part, "text", "") or "" for part in content
            )

        return TextResponse(content=content)

