from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from google import genai  # type: ignore
from google.genai import types as genai_types  # type: ignore

from .base import Provider, TextRequest, TextResponse
from app.config import get_settings


def _build_contents(messages: list) -> list[dict[str, Any]]:
    return [{"role": m.role, "parts": [{"text": m.content}]} for m in messages]


def _build_config(request: TextRequest) -> genai_types.GenerateContentConfig:
    return genai_types.GenerateContentConfig(
        temperature=request.temperature,
        max_output_tokens=request.max_tokens,
    )


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self) -> None:
        settings = get_settings()
        self._client = genai.Client(api_key=settings.gemini.api_key)

    async def generate_text(self, request: TextRequest) -> TextResponse:
        contents = _build_contents(request.messages)
        resp = self._client.models.generate_content(
            model=request.model_key,
            contents=contents,
            config=_build_config(request),
        )
        text: str = getattr(resp, "text", "") or ""
        if not text and getattr(resp, "candidates", None):
            candidate = resp.candidates[0]
            if getattr(candidate, "content", None) and getattr(candidate.content, "parts", None):
                part = candidate.content.parts[0]
                text = getattr(part, "text", "") or ""
        return TextResponse(content=text)

    async def generate_text_stream(self, request: TextRequest) -> AsyncIterator[str]:
        """Stream text chunks from Gemini. Uses aio client when available."""
        contents = _build_contents(request.messages)
        config = _build_config(request)
        try:
            stream = await self._client.aio.models.generate_content_stream(
                model=request.model_key,
                contents=contents,
                config=config,
            )
        except AttributeError:
            # Fallback: sync stream in executor would require asyncio; yield full response instead
            result = await self.generate_text(request)
            if result.content:
                yield result.content
            return
        async for chunk in stream:
            part_text = getattr(chunk, "text", None) or ""
            if part_text:
                yield part_text

