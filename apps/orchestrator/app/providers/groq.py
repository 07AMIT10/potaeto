from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

from groq import AsyncGroq  # type: ignore

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
        self._client = AsyncGroq(api_key=api_key)

    async def generate_text(self, request: TextRequest) -> TextResponse:
        kwargs: dict[str, Any] = {
            "model": request.model_key,
            "messages": _messages_for_request(request),
            "stream": False,
        }
        if request.temperature is not None:
            kwargs["temperature"] = request.temperature
        if request.max_tokens is not None:
            kwargs["max_tokens"] = request.max_tokens

        completion = await self._client.chat.completions.create(**kwargs)
        choice = completion.choices[0]
        content = getattr(choice.message, "content", "") or ""
        return TextResponse(content=content)

    async def generate_text_stream(self, request: TextRequest) -> AsyncIterator[str]:
        kwargs: dict[str, Any] = {
            "model": request.model_key,
            "messages": _messages_for_request(request),
            "stream": True,
        }
        if request.temperature is not None:
            kwargs["temperature"] = request.temperature
        if request.max_tokens is not None:
            kwargs["max_tokens"] = request.max_tokens

        stream = await self._client.chat.completions.create(**kwargs)
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = getattr(chunk.choices[0], "delta", None)
            content = getattr(delta, "content", None) or ""
            if content:
                yield content

