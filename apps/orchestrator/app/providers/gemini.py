from __future__ import annotations

from typing import Any

from google import genai  # type: ignore
from google.genai import types as genai_types  # type: ignore

from .base import Provider, TextRequest, TextResponse
from app.config import get_settings


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self) -> None:
        settings = get_settings()
        self._client = genai.Client(api_key=settings.gemini.api_key)

    async def generate_text(self, request: TextRequest) -> TextResponse:
        contents: list[dict[str, Any]] = [
            {"role": m.role, "parts": [{"text": m.content}]} for m in request.messages
        ]

        resp = self._client.models.generate_content(
            model=request.model_key,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                temperature=request.temperature,
                max_output_tokens=request.max_tokens,
            ),
        )

        text: str = getattr(resp, "text", "") or ""
        if not text and getattr(resp, "candidates", None):
            candidate = resp.candidates[0]
            if getattr(candidate, "content", None) and getattr(candidate.content, "parts", None):
                part = candidate.content.parts[0]
                text = getattr(part, "text", "") or ""

        return TextResponse(content=text)

