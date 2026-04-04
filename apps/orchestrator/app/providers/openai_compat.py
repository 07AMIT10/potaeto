from __future__ import annotations

from collections.abc import AsyncIterator
import json
from typing import Any

import httpx

from app.providers.base import Provider, TextRequest, TextResponse


class OpenAICompatibleProvider(Provider):
    """Shared implementation for OpenAI-compatible /chat/completions APIs."""

    name = "openai_compatible"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        default_headers: dict[str, str] | None = None,
        timeout_sec: float = 60.0,
    ) -> None:
        if not api_key:
            raise RuntimeError("API key is required for OpenAI-compatible provider")
        if not base_url:
            raise RuntimeError("Base URL is required for OpenAI-compatible provider")

        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._default_headers = default_headers or {}
        self._timeout_sec = timeout_sec

    def _request_payload(self, request: TextRequest, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": request.model_key,
            "messages": [
                {"role": m.role, "content": m.content}
                for m in request.messages
            ],
            "stream": stream,
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens
        return payload

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        headers.update(self._default_headers)
        return headers

    async def generate_text(self, request: TextRequest) -> TextResponse:
        payload = self._request_payload(request, stream=False)
        async with httpx.AsyncClient(timeout=self._timeout_sec) as client:
            response = await client.post(
                f"{self._base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
        response.raise_for_status()
        body = response.json()
        choices = body.get("choices", [])
        if not choices:
            return TextResponse(content="")
        message = choices[0].get("message", {})
        content = message.get("content") or ""
        if isinstance(content, list):
            content = "".join(
                part if isinstance(part, str) else str(part.get("text", ""))
                for part in content
            )
        return TextResponse(content=str(content))

    async def generate_text_stream(self, request: TextRequest) -> AsyncIterator[str]:
        payload = self._request_payload(request, stream=True)
        async with httpx.AsyncClient(timeout=self._timeout_sec) as client:
            async with client.stream(
                "POST",
                f"{self._base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = parsed.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    content = delta.get("content")
                    if content:
                        yield str(content)
