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
from typing import Any

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
SUMMARY_MARKER_PREFIX = "[Summary of earlier conversation: "
SUMMARY_MARKER_SUFFIX = "]"
RECENCY_WINDOW = 10
ROLLUP_THRESHOLD_RATIO = 0.75

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
        conn: sqlite3.Connection | None = None,
        *,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
        max_context_tokens: int | None = None,
        memory_scope: str = "global",
    ) -> None:
        if isinstance(conn, int):
            token_budget = conn
            conn = None
        if max_context_tokens is not None:
            token_budget = max_context_tokens
        self.conn = conn
        self.token_budget = token_budget
        self.max_context_tokens = token_budget
        self.CHAR_BUDGET = token_budget * 4  # chars/4 token estimate
        self.memory_scope = memory_scope
        # Larger models get more history and memory nodes, within sane caps.
        self.max_messages = min(
            MAX_MESSAGES_CAP, max(MIN_MESSAGES, token_budget // 1200)
        )
        self.max_memory_nodes = min(
            MAX_MEMORY_NODES_CAP, max(MIN_MEMORY_NODES, token_budget // 3000)
        )
        self.messages = MessageRepo(conn) if conn is not None else None
        self.entities = EntityRepo(conn) if conn is not None else None
        self.memory = MemoryService(conn) if conn is not None else None

    def build(
        self,
        user_id: str,
        entity_id: str,
        conversation_id: str,
        user_message: str,
        *,
        tools_enabled: bool = True,
    ) -> list[TextMessage]:
        entity = self.entities.get(entity_id) if self.entities else None
        memories = (
            self.memory.search(
                user_id,
                user_message,
                limit=self.max_memory_nodes,
                scope=self.memory_scope,
            )
            if self.memory
            else []
        )
        system_prompt = build_system_prompt(
            entity, memories, tools_enabled=tools_enabled
        )

        existing_summary = self._summary(conversation_id) if self.conn else None
        if existing_summary:
            system_prompt = (
                f"{system_prompt}\n\nSummary of the conversation so far:\n{existing_summary}"
            )

        history = self._history(conversation_id)
        messages = list(history)
        if user_message:
            messages.append(TextMessage(role="user", content=user_message))

        return self.build_context(
            messages=messages,
            system_prompt=system_prompt,
        )

    def build_context(
        self,
        messages: list[Any] | None = None,
        memories: list[Any] | None = None,
        system_prompt: str = "",
        *,
        user_message: str | None = None,
    ) -> list[TextMessage]:
        """Assemble context with 75% summary rollup and token budget enforcement."""
        normalized: list[TextMessage] = []
        if messages:
            for m in messages:
                msg = self._normalize_message(m)
                if msg.role == "assistant" and not (msg.content or "").strip():
                    continue
                normalized.append(msg)
        if user_message:
            normalized.append(TextMessage(role="user", content=user_message))

        full_system = (system_prompt or "").strip()
        if memories:
            mem_lines = []
            for mem in memories:
                if isinstance(mem, str):
                    mem_lines.append(f"- {mem}")
                elif hasattr(mem, "id") and hasattr(mem, "content"):
                    mem_lines.append(f"- [{mem.id}] {mem.content}")
                elif isinstance(mem, dict):
                    mid = mem.get("id", "mem")
                    cnt = mem.get("content", "")
                    mem_lines.append(f"- [{mid}] {cnt}")
            if mem_lines:
                mem_block = "Relevant memories:\n" + "\n".join(mem_lines)
                full_system = (
                    f"{full_system}\n\n{mem_block}".strip()
                    if full_system
                    else mem_block
                )

        prefix: list[TextMessage] = []
        if full_system:
            prefix.append(TextMessage(role="system", content=full_system))

        threshold_chars = int(self.token_budget * ROLLUP_THRESHOLD_RATIO) * 4
        prefix_chars = sum(len(m.content) for m in prefix)
        messages_chars = sum(len(m.content) for m in normalized)
        total_chars = prefix_chars + messages_chars

        if total_chars > threshold_chars and len(normalized) > RECENCY_WINDOW:
            older_messages = normalized[:-RECENCY_WINDOW]
            recent_messages = normalized[-RECENCY_WINDOW:]

            recent_chars = sum(len(m.content) for m in recent_messages)
            wrapper_len = len(SUMMARY_MARKER_PREFIX) + len(SUMMARY_MARKER_SUFFIX)
            avail_summary_chars = max(
                0, threshold_chars - prefix_chars - recent_chars - wrapper_len
            )

            summary_text = self._roll_up_messages(
                older_messages, max_chars=avail_summary_chars
            )
            summary_msg = TextMessage(
                role="system",
                content=f"{SUMMARY_MARKER_PREFIX}{summary_text}{SUMMARY_MARKER_SUFFIX}",
            )

            current_prefix = list(prefix)
            if prefix_chars + len(summary_msg.content) + recent_chars > threshold_chars:
                prefix_allowance = max(
                    0, threshold_chars - len(summary_msg.content) - recent_chars
                )
                if prefix_allowance < prefix_chars:
                    current_prefix = self._truncate_prefix(
                        current_prefix, prefix_allowance
                    )

            assembled = list(current_prefix) + [summary_msg] + list(recent_messages)
        else:
            assembled = list(prefix) + list(normalized)

        total_assembled = sum(len(m.content) for m in assembled)
        if total_assembled > self.CHAR_BUDGET:
            prefix_msgs = [m for m in assembled if m.role == "system"]
            hist_msgs = [m for m in assembled if m.role != "system"]
            assembled = self._apply_budget_to_assembled(prefix_msgs, hist_msgs)

        total = sum(len(m.content) for m in assembled)
        logger.info(
            "context assembled: %s chars ~%s tokens (budget %s)",
            total,
            total // 4,
            self.token_budget,
        )
        return assembled

    @staticmethod
    def _normalize_message(msg: Any) -> TextMessage:
        if isinstance(msg, TextMessage):
            return msg
        if isinstance(msg, dict):
            return TextMessage(
                role=msg.get("role", "user"),
                content=msg.get("content", ""),
            )
        return TextMessage(
            role=getattr(msg, "role", "user"),
            content=getattr(msg, "content", ""),
        )

    @staticmethod
    def _roll_up_messages(messages: list[TextMessage], max_chars: int) -> str:
        """Deterministically summarize older conversation turns."""
        if not messages:
            return ""
        entries: list[str] = []
        for msg in messages:
            role = msg.role.capitalize()
            snippet = " ".join(msg.content.strip().split())
            if len(snippet) > 80:
                snippet = snippet[:77] + "..."
            entries.append(f"{role}: {snippet}")

        header = f"{len(messages)} earlier messages: "
        body = "; ".join(entries)
        full = header + body

        if max_chars is not None and len(full) > max_chars:
            if max_chars >= len(header) + 15:
                body_avail = max_chars - len(header) - 3
                full = header + body[:body_avail] + "..."
            elif max_chars >= len(header):
                full = header[:max_chars]
            else:
                full = f"{len(messages)} earlier messages"[:max_chars]
        if not full:
            full = f"{len(messages)} earlier turns"
        return full

    def _history(self, conversation_id: str) -> list[TextMessage]:
        if self.messages is None:
            return []
        rows = self.messages.list(conversation_id)[
            -max(self.max_messages * 4, 100) :
        ]
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
        if self.conn is None:
            return None
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

    def _apply_budget_to_assembled(
        self,
        prefix: list[TextMessage],
        history: list[TextMessage],
    ) -> list[TextMessage]:
        """Cap total context at CHAR_BUDGET, dropping oldest history first."""
        budget = self.CHAR_BUDGET
        prefix_len = sum(len(m.content) for m in prefix)
        history_allowance = max(0, budget - prefix_len)
        selected: list[TextMessage] = []
        used = 0
        for message in reversed(history):
            if used + len(message.content) <= history_allowance:
                selected.append(message)
                used += len(message.content)
            else:
                break
        selected.reverse()

        prefix_allowance = max(0, budget - used)
        if prefix_len > prefix_allowance:
            prefix = self._truncate_prefix(prefix, prefix_allowance)

        result = list(prefix)
        result.extend(selected)
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
