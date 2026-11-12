"""Provider abstractions.

This module keeps the legacy text shapes (``TextMessage``/``TextRequest``/
``TextResponse``/``Provider.generate_text``) used by the model router and the
older adapters, and adds the streaming catalog interface alongside them:
``ModelInfo``, ``ChatRequest``, ``StreamEvent``, ``list_models`` and
``stream_chat``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

Role = Literal["user", "assistant", "system"]


# ── legacy text interface ─────────────────────────────────────────────


@dataclass
class TextMessage:
    role: Role
    content: str

    def __getitem__(self, item: str) -> Any:
        if item == "role":
            return self.role
        if item == "content":
            return self.content
        raise KeyError(item)

    def __contains__(self, item: object) -> bool:
        return item in ("role", "content")

    def __eq__(self, other: object) -> bool:
        if isinstance(other, TextMessage):
            return self.role == other.role and self.content == other.content
        if isinstance(other, dict):
            return self.role == other.get("role") and self.content == other.get("content")
        return False

    def __hash__(self) -> int:
        return hash((self.role, self.content))

    def keys(self) -> list[str]:
        return ["role", "content"]

    def get(self, key: str, default: Any = None) -> Any:
        if key == "role":
            return self.role
        if key == "content":
            return self.content
        return default


@dataclass
class TextRequest:
    model_key: str
    messages: list[TextMessage]
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass
class TextResponse:
    content: str


class Provider(Protocol):
    name: str

    async def generate_text(self, request: TextRequest) -> TextResponse: ...

    # image / tts hooks can be added later


# ── streaming catalog interface ───────────────────────────────────────


@dataclass
class ChatMessage:
    """A single message in an OpenAI-compatible chat request.

    ``tool_calls``/``tool_call_id``/``name`` are carried through verbatim so
    tool-result turns round-trip without the provider needing to interpret them.
    """

    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    name: str | None = None


@dataclass
class ChatRequest:
    model: str
    messages: list[ChatMessage]
    tools: list[dict[str, Any]] | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass
class ModelInfo:
    provider: str
    id: str
    name: str = ""
    context_length: int | None = None
    max_output_tokens: int | None = None
    supports_tools: bool = False
    protocol: str = "openai"
    pricing: dict[str, Any] | None = None
    retention: str | None = None
    base_url: str | None = None


@dataclass(frozen=True)
class StreamEvent:
    """One chunk of a streaming completion.

    ``type`` discriminates the variants:

    - ``token`` (``text``)
    - ``tool_call_delta`` (``index``, ``id``, ``name``, ``args``)
    - ``done`` (``finish_reason``, ``usage``)
    - ``error`` (``code``, ``message``)
    """

    type: Literal["token", "tool_call_delta", "done", "error"]
    text: str | None = None
    index: int | None = None
    id: str | None = None
    name: str | None = None
    args: str | None = None
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    code: str | None = None
    message: str | None = None

    @classmethod
    def token(cls, text: str) -> StreamEvent:
        return cls(type="token", text=text)

    @classmethod
    def tool_call_delta(
        cls,
        index: int | None,
        id: str | None,
        name: str | None,
        args: str,
    ) -> StreamEvent:
        return cls(type="tool_call_delta", index=index, id=id, name=name, args=args)

    @classmethod
    def done(
        cls,
        finish_reason: str | None,
        usage: dict[str, Any] | None = None,
    ) -> StreamEvent:
        return cls(type="done", finish_reason=finish_reason, usage=usage)

    @classmethod
    def error(cls, code: str, message: str) -> StreamEvent:
        return cls(type="error", code=code, message=message)


class ChatProvider(Protocol):
    """A provider that can enumerate models and stream chat completions."""

    name: str

    def list_models(self) -> Awaitable[list[ModelInfo]]: ...

    def stream_chat(self, request: ChatRequest) -> AsyncIterator[StreamEvent]: ...
