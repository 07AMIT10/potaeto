from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Literal, Any


Role = Literal["user", "assistant", "system"]


@dataclass
class TextMessage:
    role: Role
    content: str


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

    async def generate_text(self, request: TextRequest) -> TextResponse:
        ...

    # image / tts hooks can be added later

