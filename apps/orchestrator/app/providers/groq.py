from __future__ import annotations

import os
from typing import Any

from groq import Groq  # type: ignore

from app.providers.base import Provider, TextRequest, TextResponse


class GroqProvider(Provider):
    name = "groq"

    def __init__(self) -> None:
        api_key = os.environ.get("GROQ_API_KEY") or os.environ.get("GROQ_API_KEY_ORCHESTRATOR")
        if not api_key:
            raise RuntimeError("Groq API key not configured for orchestrator")
        self._client = Groq(api_key=api_key)

    async def generate_text(self, request: TextRequest) -> TextResponse:
        messages: list[dict[str, Any]] = [
            {"role": request_message.role, "content": request_message.content}
            for request_message in request.messages
        ]

        completion = self._client.chat.completions.create(
            model=request.model_key,
            messages=messages,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=False,
        )

        choice = completion.choices[0]
        content = getattr(choice.message, "content", "") or ""

        return TextResponse(content=content)

