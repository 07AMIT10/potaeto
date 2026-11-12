"""OpenAI-compatible provider and streaming helpers.

The legacy ``OpenAICompatibleProvider`` (``generate_text`` / ``generate_text_stream``)
remains intact for the existing adapters (Cerebras, SambaNova, …). On top of it,
this module exposes the shared machinery used by the new streaming providers:

- ``build_chat_payload`` — OpenAI-compatible request body (tools are forwarded,
  never executed).
- ``parse_openai_stream`` — SSE parser that tolerates comments, fragmented
  events, ``[DONE]``, accumulates tool-call deltas by index, and maps
  ``finish_reason``/``usage``/mid-stream ``error`` into ``StreamEvent``.
- ``stream_openai_chat`` — POST + parse in one step for the new providers.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.providers.base import (
    ChatRequest,
    Provider,
    StreamEvent,
    TextRequest,
    TextResponse,
)


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
                {"role": m.role, "content": m.content} for m in request.messages
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


# ── streaming machinery (shared by the new providers) ─────────────────


def build_chat_payload(request: ChatRequest, stream: bool = True) -> dict[str, Any]:
    """Build an OpenAI-compatible /chat/completions body from a ``ChatRequest``.

    ``tools`` are forwarded verbatim; the provider never executes them.
    """
    messages: list[dict[str, Any]] = []
    for m in request.messages:
        msg: dict[str, Any] = {"role": m.role, "content": m.content}
        if m.tool_call_id is not None:
            msg["tool_call_id"] = m.tool_call_id
        if m.tool_calls is not None:
            msg["tool_calls"] = m.tool_calls
        if m.name is not None:
            msg["name"] = m.name
        messages.append(msg)

    payload: dict[str, Any] = {
        "model": request.model,
        "messages": messages,
        "stream": stream,
    }
    if request.tools is not None:
        payload["tools"] = request.tools
    if request.temperature is not None:
        payload["temperature"] = request.temperature
    if request.max_tokens is not None:
        payload["max_tokens"] = request.max_tokens
    return payload


async def error_from_response(response: httpx.Response) -> StreamEvent:
    """Map a non-2xx HTTP response to an error ``StreamEvent``."""
    code = f"http_{response.status_code}"
    message = f"Provider returned HTTP {response.status_code}"
    body: Any = None
    try:
        raw = await response.aread()
        body = json.loads(raw) if raw else None
    except (ValueError, json.JSONDecodeError):
        body = None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            code = str(err.get("code") or err.get("type") or code)
            message = str(err.get("message") or message)
        elif isinstance(err, str) and err:
            message = err
    return StreamEvent.error(code, message)


async def parse_openai_stream(response: httpx.Response) -> AsyncIterator[StreamEvent]:
    """Parse an SSE /chat/completions response into ``StreamEvent``s.

    Handles SSE comments (``: ...``), fragmented/multi-line ``data:`` events,
    the ``[DONE]`` sentinel, and plain JSON bodies (e.g. a mocked response).
    Tool-call deltas are accumulated by ``index`` (tolerating a missing index
    after the first chunk) but never executed. ``finish_reason``/``usage`` are
    collapsed into a single terminal ``done`` event; a mid-stream ``error``
    yields an ``error`` event instead.
    """
    # index -> {"id": str|None, "name": str|None, "args": str}
    tool_calls: dict[int, dict[str, Any]] = {}
    last_index: int | None = None
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    errored = False

    def handle(text: str) -> list[StreamEvent]:
        nonlocal finish_reason, usage, errored, last_index
        text = text.strip()
        if not text or text == "[DONE]":
            return []
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            return []
        if not isinstance(obj, dict):
            return []

        events: list[StreamEvent] = []

        # Mid-stream or HTTP-200 error payload.
        error = obj.get("error")
        if error:
            if isinstance(error, dict):
                code = str(error.get("code") or error.get("type") or "provider_error")
                message = str(error.get("message") or "provider error")
            else:
                code, message = "provider_error", str(error)
            errored = True
            events.append(StreamEvent.error(code, message))

        choices = obj.get("choices") or []
        if choices:
            choice = choices[0]
            delta = choice.get("delta") or {}
            if isinstance(delta, dict):
                content = delta.get("content")
                if isinstance(content, str) and content:
                    events.append(StreamEvent.token(content))
                elif isinstance(content, list):
                    for part in content:
                        text = part.get("text") if isinstance(part, dict) else str(part)
                        if text:
                            events.append(StreamEvent.token(str(text)))

                for tc in delta.get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    index = tc.get("index")
                    if index is None:
                        index = last_index if last_index is not None else 0
                    last_index = index
                    acc = tool_calls.setdefault(
                        index, {"id": None, "name": None, "args": ""}
                    )
                    if tc.get("id") is not None:
                        acc["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name") is not None:
                        acc["name"] = fn["name"]
                    if fn.get("arguments"):
                        acc["args"] += fn["arguments"]
                    events.append(
                        StreamEvent.tool_call_delta(
                            index=index,
                            id=acc["id"],
                            name=acc["name"],
                            args=acc["args"],
                        )
                    )

            if choice.get("finish_reason") and finish_reason is None:
                finish_reason = choice.get("finish_reason")

        if obj.get("usage") is not None:
            usage = obj.get("usage")

        # A finish_reason of "error" without an error body is still an error.
        if finish_reason == "error" and not errored:
            errored = True
            events.append(
                StreamEvent.error(
                    "stream_error", "Provider reported finish_reason=error"
                )
            )

        return events

    data_parts: list[str] = []

    async for line in response.aiter_lines():
        line = line.rstrip("\r")
        if not line:
            if data_parts:
                for event in handle("\n".join(data_parts)):
                    yield event
                data_parts = []
            continue
        if line.startswith(":"):
            continue  # SSE comment, e.g. ": OPENROUTER PROCESSING"
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            data_parts.append(payload)
            continue
        stripped = line.strip()
        if stripped.startswith("{"):
            # Bare JSON body (a non-SSE, e.g. mocked, response).
            data_parts.append(stripped)
        # Any other SSE field (event:, id:, retry:, …) is ignored.

    if data_parts:
        for event in handle("\n".join(data_parts)):
            yield event

    if not errored:
        yield StreamEvent.done(finish_reason, usage)


async def stream_openai_chat(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
) -> AsyncIterator[StreamEvent]:
    """POST an OpenAI-compatible chat payload and stream parsed events."""
    try:
        async with client.stream(
            "POST", url, headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                yield await error_from_response(response)
                return
            async for event in parse_openai_stream(response):
                yield event
    except httpx.HTTPError as exc:
        yield StreamEvent.error("network_error", str(exc))
