"""Context assembly within a dynamic token budget.

A turn's context is assembled in priority order: the pinned system prompt
(persona + retrieved memory nodes), the rolling summary, the last few history
messages, and finally the incoming user message. The total is capped at the
builder's token budget (estimated as ``chars / 4``); when history would push
the context over budget, the oldest messages are dropped first, and an
oversized memory/summary block is truncated with a visible marker.

The budget is derived from the selected model's catalog ``context_length`` by
:func:`compute_context_budget`, bounded by a configurable floor and ceiling.
"""

from __future__ import annotations

import logging
import sqlite3

from app.agent.prompts import build_system_prompt
from app.db.repositories.base import fetch_one
from app.db.repositories.entities import EntityRepo
from app.db.repositories.messages import MessageRepo
from app.memory.service import MemoryService
from app.providers.base import TextMessage

DEFAULT_TOKEN_BUDGET = 8_000
TOKEN_BUDGET = DEFAULT_TOKEN_BUDGET  # backwards-compatible module alias
MAX_MESSAGES_CAP = 30
MIN_MESSAGES = 10
MAX_MEMORY_NODES_CAP = 16
MIN_MEMORY_NODES = 8
#: Token headroom left for the provider's own framing and response overhead.
CONTEXT_SAFETY_TOKENS = 1024
TRUNCATION_MARKER = "\n\n[context truncated to fit the model budget]"

logger = logging.getLogger(__name__)

_ROLE_WHITELIST = frozenset({"user", "assistant", "system"})


def compute_context_budget(
    context_length: int | None,
    max_output_tokens: int | None,
    ceiling: int,
    floor: int,
) -> int:
    """Derive this turn's token budget from the model catalog window.

    ``usable`` reserves the configured output cap plus a fixed safety margin
    for provider framing, then clamps into ``[floor, ceiling]``. Providers
    without catalog metadata fall back to the historical 8k budget.
    """
    if not context_length or context_length <= 0:
        return DEFAULT_TOKEN_BUDGET
    usable = context_length - (max_output_tokens or 0) - CONTEXT_SAFETY_TOKENS
    return max(floor, min(usable, ceiling))


class ContextBuilder:
    """Build the provider-facing message list for a single turn."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
        memory_scope: str = "global",
    ) -> None:
        self.conn = conn
        self.token_budget = token_budget
        self.CHAR_BUDGET = token_budget * 4  # chars/4 token estimate
        self.memory_scope = memory_scope
        # Larger models get more history and memory nodes, within sane caps.
        self.max_messages = min(
            MAX_MESSAGES_CAP, max(MIN_MESSAGES, token_budget // 1200)
        )
        self.max_memory_nodes = min(
            MAX_MEMORY_NODES_CAP, max(MIN_MEMORY_NODES, token_budget // 3000)
        )
        self.messages = MessageRepo(conn)
        self.entities = EntityRepo(conn)
        self.memory = MemoryService(conn)

    def build(
        self,
        user_id: str,
        entity_id: str,
        conversation_id: str,
        user_message: str,
        *,
        tools_enabled: bool = True,
    ) -> list[TextMessage]:
        entity = self.entities.get(entity_id)
        memories = self.memory.search(
            user_id,
            user_message,
            limit=self.max_memory_nodes,
            scope=self.memory_scope,
        )
        prefix = [
            TextMessage(
                role="system",
                content=build_system_prompt(
                    entity, memories, tools_enabled=tools_enabled
                ),
            )
        ]

        summary = self._summary(conversation_id)
        if summary:
            prefix.append(
                TextMessage(
                    role="system",
                    content=f"Summary of the conversation so far:\n{summary}",
                )
            )

        history = self._history(conversation_id)
        return self._apply_budget(prefix, history, user_message)

    def _history(self, conversation_id: str) -> list[TextMessage]:
        rows = self.messages.list(conversation_id)[-self.max_messages :]
        history: list[TextMessage] = []
        for message in rows:
            # An empty assistant row (the provider returned no text before the
            # guard) must never be replayed as context.
            if message.role == "assistant" and not (message.content or "").strip():
                continue
            history.append(
                TextMessage(
                    role=message.role if message.role in _ROLE_WHITELIST else "user",
                    content=message.content,
                )
            )
        return history

    def _summary(self, conversation_id: str) -> str | None:
        row = fetch_one(
            self.conn,
            "SELECT summary FROM conversation_summaries WHERE conversation_id = ?",
            (conversation_id,),
        )
        if row is None:
            return None
        summary = (row["summary"] or "").strip()
        return summary or None

    def _apply_budget(
        self,
        prefix: list[TextMessage],
        history: list[TextMessage],
        user_message: str,
    ) -> list[TextMessage]:
        """Cap the whole context (prefix + history + user) at ``CHAR_BUDGET``.

        Oldest history is dropped first. If the pinned prefix (system prompt,
        memory block, summary) still cannot fit, it is truncated with a marker
        so the model knows its context was shortened.
        """
        budget = self.CHAR_BUDGET
        user_content = user_message
        if len(user_content) > budget:
            marker = "\n\n[message truncated to fit the model budget]"
            user_content = user_content[: max(0, budget - len(marker))] + marker
        user_msg = TextMessage(role="user", content=user_content)

        prefix_len = sum(len(m.content) for m in prefix)
        history_allowance = max(0, budget - len(user_content) - prefix_len)
        selected: list[TextMessage] = []
        used = 0
        # Walk newest-first and keep a contiguous block that fits.
        for message in reversed(history):
            if used + len(message.content) <= history_allowance:
                selected.append(message)
                used += len(message.content)
            else:
                break
        selected.reverse()

        prefix_allowance = max(0, budget - len(user_content) - used)
        if prefix_len > prefix_allowance:
            prefix = self._truncate_prefix(prefix, prefix_allowance)

        result = list(prefix)
        result.extend(selected)
        result.append(user_msg)
        total = sum(len(m.content) for m in result)
        logger.info(
            "context assembled: %s chars ~%s tokens (budget %s)",
            total,
            total // 4,
            self.token_budget,
        )
        return result

    @staticmethod
    def _truncate_prefix(
        prefix: list[TextMessage], allowance: int
    ) -> list[TextMessage]:
        """Trim the pinned prefix to ``allowance`` chars, preserving order."""
        remaining = max(0, allowance)
        trimmed: list[TextMessage] = []
        for message in prefix:
            content = message.content
            if remaining <= 0:
                break
            if len(content) <= remaining:
                trimmed.append(message)
                remaining -= len(content)
                continue
            if remaining <= len(TRUNCATION_MARKER):
                trimmed.append(
                    TextMessage(role=message.role, content=TRUNCATION_MARKER[:remaining])
                )
            else:
                keep = remaining - len(TRUNCATION_MARKER)
                trimmed.append(
                    TextMessage(
                        role=message.role,
                        content=content[:keep] + TRUNCATION_MARKER,
                    )
                )
            remaining = 0
            break
        return trimmed
