"""OpenCode Go provider.

Discovery is anonymous and follows the fallback chain described in the spec:

1. ``GET https://opencode.ai/inference/go/v1/models`` — no ``Authorization``.
2. On 401/403, retry anonymously.
3. ``GET https://opencode.ai/inference/v1/models``.
4. ``GET https://models.dev/api.json`` (``providers["opencode-go"]``) — metadata
   fallback only, never authoritative for the live Go-plan lineup.
5. Bundled snapshot.

Inference starts with the OpenAI-compatible chat endpoint under the Go base URL
and requires both ``Authorization: Bearer oc_sk_…`` and ``x-opencode-session``.
On a ``400 ModelProtocolUnsupported`` it falls back to the model's native
protocol (``responses`` → ``/openai/v1/responses``, ``messages`` →
``/anthropic/v1/messages``, ``google`` → ``/google/v1beta/models/{model}:
generateContent``) as a single, non-streaming request.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Any

import httpx

from app.catalog import normalize
from app.providers.base import ChatMessage, ChatRequest, ModelInfo, StreamEvent
from app.providers.openai_compat import (
    build_chat_payload,
    error_from_response,
    parse_openai_stream,
)

DISCOVERY_URL = "https://opencode.ai/inference/go/v1/models"
DISCOVERY_FALLBACK_URL = "https://opencode.ai/inference/v1/models"
MODELS_DEV_URL = "https://models.dev/api.json"
INFERENCE_BASE = "https://opencode.ai/inference/go"
CHAT_PATH = "/openai/v1/chat/completions"


def make_session_id() -> str:
    """Return a ``ses_<32 hex>`` session id (used when the caller doesn't supply
    a conversation-derived one)."""
    return "ses_" + secrets.token_hex(16)


class OpenCodeGoProvider:
    name = "opencode_go"

    def __init__(
        self,
        *,
        api_key: str,
        session_id: str | None = None,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_sec: float = 60.0,
    ) -> None:
        if not api_key:
            raise RuntimeError("OpenCode Go API key is required")
        self._api_key = api_key
        self._session_id = session_id or make_session_id()
        self._base_url = (base_url or INFERENCE_BASE).rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout_sec)
        self._owns_client = client is None
        self._model_infos: dict[str, ModelInfo] = {}

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ── discovery ─────────────────────────────────────────────────────

    async def _get_json(self, url: str) -> dict[str, Any] | None:
        response = await self._client.get(url)
        if response.status_code == 200:
            try:
                body = response.json()
            except ValueError:
                return None
            return body if isinstance(body, dict) else None
        return None

    async def list_models(self) -> list[ModelInfo]:
        models = await self._resolve_models()
        self._model_infos = {model.id: model for model in models}
        return models

    async def _resolve_models(self) -> list[ModelInfo]:
        # 1. Primary anonymous discovery.
        models = await self._discover_opencode(DISCOVERY_URL, retry_anonymous=True)
        if models is not None:
            return models

        # 2. Generic inference catalog fallback.
        models = await self._discover_opencode(
            DISCOVERY_FALLBACK_URL, retry_anonymous=False
        )
        if models is not None:
            return models

        # 3. models.dev metadata fallback (never authoritative).
        body = await self._get_json(MODELS_DEV_URL)
        if body is not None:
            models = normalize.normalize_models_dev(body)
            if models:
                return models

        # 4. Bundled snapshot.
        return normalize.snapshot_models()

    async def _discover_opencode(
        self,
        url: str,
        *,
        retry_anonymous: bool,
    ) -> list[ModelInfo] | None:
        response = await self._client.get(url)  # anonymous: no Authorization
        if response.status_code in (401, 403) and retry_anonymous:
            response = await self._client.get(url)  # anonymous retry
        if response.status_code != 200:
            return None
        try:
            body = response.json()
        except ValueError:
            return None
        if not isinstance(body, dict):
            return None
        return normalize.normalize_opencode_models(body)

    # ── inference ─────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "x-opencode-session": self._session_id,
        }

    def stream_chat(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        return self._stream_chat(request)

    async def _stream_chat(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        payload = build_chat_payload(request, stream=True)
        url = f"{self._base_url}{CHAT_PATH}"
        headers = self._headers()
        try:
            async with self._client.stream(
                "POST", url, headers=headers, json=payload
            ) as response:
                if response.status_code == 400 and await self._is_protocol_unsupported(
                    response
                ):
                    async for event in self._native_fallback(request, headers):
                        yield event
                    return
                if response.status_code >= 400:
                    yield await error_from_response(response)
                    return
                async for event in parse_openai_stream(response):
                    yield event
        except httpx.HTTPError as exc:
            yield StreamEvent.error("network_error", str(exc))

    async def _read_json(self, response: httpx.Response) -> dict[str, Any] | None:
        try:
            raw = await response.aread()
        except httpx.HTTPError:
            return None
        if not raw:
            return None
        try:
            body = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            return None
        return body if isinstance(body, dict) else None

    async def _is_protocol_unsupported(self, response: httpx.Response) -> bool:
        body = await self._read_json(response)
        if body is None:
            return False
        if body.get("type") == "ModelProtocolUnsupported":
            return True
        error = body.get("error")
        if isinstance(error, dict):
            return (
                error.get("code") or error.get("type")
            ) == "ModelProtocolUnsupported"
        return False

    def _native_endpoint(
        self, protocol: str, model: str, base_url: str | None
    ) -> str | None:
        if not base_url:
            return None
        base = base_url.rstrip("/")
        if protocol == "responses":
            return f"{base}/responses"
        if protocol == "messages":
            return f"{base}/messages"
        if protocol == "google":
            return f"{base}/models/{model}:generateContent"
        return None

    def _build_native_body(self, protocol: str, request: ChatRequest) -> dict[str, Any]:
        messages = [{"role": m.role, "content": m.content} for m in request.messages]
        if protocol == "messages":
            system = "\n".join(m["content"] for m in messages if m["role"] == "system")
            body: dict[str, Any] = {
                "model": request.model,
                "max_tokens": request.max_tokens or 1024,
                "messages": [m for m in messages if m["role"] != "system"],
            }
            if system:
                body["system"] = system
            return body
        if protocol == "responses":
            return {
                "model": request.model,
                "input": [
                    {"role": m["role"], "content": m["content"]} for m in messages
                ],
            }
        if protocol == "google":
            return {
                "contents": [
                    {
                        "role": "model" if m["role"] == "assistant" else "user",
                        "parts": [{"text": m["content"]}],
                    }
                    for m in messages
                ]
            }
        return {}

    def _extract_native_text(self, protocol: str, data: dict[str, Any]) -> str:
        if protocol == "messages":
            return "".join(
                block.get("text") or ""
                for block in data.get("content") or []
                if isinstance(block, dict) and block.get("type") == "text"
            )
        if protocol == "responses":
            if data.get("output_text"):
                return str(data["output_text"])
            parts: list[str] = []
            for item in data.get("output") or []:
                if not isinstance(item, dict) or item.get("type") != "message":
                    continue
                for block in item.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "output_text":
                        parts.append(block.get("text") or "")
            return "".join(parts)
        if protocol == "google":
            try:
                return data["candidates"][0]["content"]["parts"][0]["text"]
            except (KeyError, IndexError, TypeError):
                return ""
        return ""

    @staticmethod
    def _without_tools(request: ChatRequest) -> ChatRequest:
        """Drop tools and tell the model why, instead of failing the turn.

        Native one-shot bodies carry role/content only. A native-only model
        must still be usable, so the fallback asks for a plain answer rather
        than returning ``tools_unsupported`` and leaving the agent stuck.
        """
        note = ChatMessage(
            role="system",
            content=(
                "Tool calls are unavailable for this model. Answer using the "
                "conversation and memories provided, without attempting a tool call."
            ),
        )
        return ChatRequest(
            model=request.model,
            messages=[note, *request.messages],
            tools=None,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )

    async def _native_fallback(
        self, request: ChatRequest, headers: dict[str, str]
    ) -> AsyncIterator[StreamEvent]:
        model = request.model
        info = self._model_infos.get(model)
        if info is None:
            with suppress(Exception):
                await self.list_models()
            info = self._model_infos.get(model)

        endpoint = (
            self._native_endpoint(info.protocol, model, info.base_url)
            if info is not None
            else None
        )
        if endpoint is None:
            yield StreamEvent.error(
                "protocol_unsupported",
                f"No native protocol fallback for model {model}",
            )
            return

        protocol = info.protocol
        native_request = self._without_tools(request) if request.tools else request
        try:
            response = await self._client.post(
                endpoint,
                headers=headers,
                json=self._build_native_body(protocol, native_request),
            )
        except httpx.HTTPError as exc:
            yield StreamEvent.error("native_fallback_failed", str(exc))
            return

        if response.status_code >= 400:
            yield await error_from_response(response)
            return

        try:
            data = response.json()
        except ValueError:
            data = None
        text = (
            self._extract_native_text(protocol, data) if isinstance(data, dict) else ""
        )
        if text:
            yield StreamEvent.token(text)
        yield StreamEvent.done("stop", None)
