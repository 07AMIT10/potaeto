from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

from groq import Groq  # type: ignore

from app.providers.base import Provider, TextRequest, TextResponse


def _messages_for_request(request: TextRequest) -> list[dict[str, Any]]:
    return [
        {"role": m.role, "content": m.content}
        for m in request.messages
    ]


class GroqProvider(Provider):
    name = "groq"

    def __init__(self) -> None:
        api_key = os.environ.get("GROQ_API_KEY") or os.environ.get("GROQ_API_KEY_ORCHESTRATOR")
        if not api_key:
            raise RuntimeError("Groq API key not configured for orchestrator")
        self._client = Groq(api_key=api_key)

    async def generate_text(self, request: TextRequest) -> TextResponse:
        completion = self._client.chat.completions.create(
            model=request.model_key,
            messages=_messages_for_request(request),
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=False,
        )
        choice = completion.choices[0]
        content = getattr(choice.message, "content", "") or ""
        return TextResponse(content=content)

    async def generate_text_stream(self, request: TextRequest) -> AsyncIterator[str]:
        # Groq SDK returns a sync iterator; yield full response to avoid blocking the event loop.
        # For true streaming with Groq, use a thread pool or async SDK if available.
        result = await self.generate_text(request)
        if result.content:
            yield result.content

