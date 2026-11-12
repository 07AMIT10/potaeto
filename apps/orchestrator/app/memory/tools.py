"""Agent-facing memory tools.

These are plain callables (plus a name → callable map) so the agent loop can
register them without this module knowing anything about providers, prompts, or
tool-call transport. Reads return JSON-ready dictionaries; writes return the
stored memory as a dictionary.

Writes are governed: a ``source`` is mandatory, and tools always store
``user_confirmed=False``. Confirmation is an authenticated UI/API action, never
something the model can request, so tool output stays a candidate instead of
becoming an auto-promoted personal fact.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import asdict
from typing import Any

from app.memory.service import MemoryService

#: A search result is a *pointer*: full bodies are only returned by an explicit
#: ``memory_recall``. 8 KB of memory bodies in one tool turn is what blew the
#: context budget on 2026-11-11.
SEARCH_CONTENT_CHAR_CAP = 1_600


def _serialize(memory) -> dict[str, Any]:
    return asdict(memory)


def _serialize_compact(memory) -> dict[str, Any]:
    """Serialize a search hit, truncating its body and citing the recall id."""
    data = asdict(memory)
    content = data.get("content") or ""
    if len(content) > SEARCH_CONTENT_CHAR_CAP:
        data["content"] = (
            content[:SEARCH_CONTENT_CHAR_CAP]
            + f"… (recall via memory_recall {data['id']})"
        )
    return data


class MemoryTools:
    """Tool wrapper around :class:`MemoryService` for one agent.

    ``default_scope`` is the scope used when the model omits ``scope`` on a
    search. It defaults to ``global`` for backwards compatibility, but the loop
    passes its configured project scope so a bare ``memory_search`` call sees the
    same project nodes as the assembled context.
    """

    def __init__(self, conn: sqlite3.Connection, default_scope: str = "global") -> None:
        self.service = MemoryService(conn)
        self.default_scope = default_scope

    # -- reads ----------------------------------------------------------

    def memory_search(
        self,
        user_id: str,
        query: str,
        limit: int = 10,
        scope: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search active memories visible in ``scope`` (default: agent scope)."""
        resolved_scope = scope or self.default_scope
        return [
            _serialize_compact(m)
            for m in self.service.search(
                user_id, query, int(limit), scope=resolved_scope
            )
        ]

    def memory_recall(self, memory_id: str) -> dict[str, Any]:
        """Fetch one memory by id, including superseded/retracted history."""
        return _serialize(self.service.recall(memory_id))

    # -- writes ---------------------------------------------------------

    def memory_add(
        self,
        user_id: str,
        content: str,
        *,
        source: str,
        kind: str = "fact",
        entity_id: str | None = None,
        scope: str = "global",
        source_ref: str | None = None,
        confidence: float = 0.5,
        sensitivity: str = "normal",
    ) -> dict[str, Any]:
        """Store a candidate memory; ``source`` is required.

        The model cannot set ``user_confirmed``: this tool always writes
        ``False`` and confirmation is a separate authenticated action.
        """
        memory = self.service.add(
            user_id,
            entity_id,
            kind,
            content,
            source,
            source_ref,
            confidence,
            scope,
            sensitivity,
            False,
        )
        return _serialize(memory)

    def memory_update(
        self,
        memory_id: str,
        content: str | None = None,
        confidence: float | None = None,
    ) -> dict[str, Any]:
        """Correct a memory in place without deleting its governance history."""
        return _serialize(self.service.update(memory_id, content=content, confidence=confidence))

    def memory_supersede(self, old_id: str, new_id: str) -> dict[str, str]:
        """Mark ``old_id`` superseded by ``new_id``."""
        self.service.supersede(old_id, new_id)
        return {"superseded": old_id, "by": new_id}

    def memory_retract(self, memory_id: str) -> dict[str, str]:
        """Retract a memory so it can never influence retrieval again."""
        self.service.retract(memory_id)
        return {"retracted": memory_id, "status": "retracted"}

    def memory_journal(
        self,
        user_id: str,
        summary: str,
        *,
        source: str = "agent",
        scope: str = "global",
        source_ref: str | None = None,
    ) -> dict[str, Any]:
        """Record a session/journal note as an unconfirmed memory node."""
        memory = self.service.add(
            user_id,
            None,
            "journal",
            summary,
            source,
            source_ref,
            0.6,
            scope,
            "normal",
            False,
        )
        return _serialize(memory)

    def as_tool_map(self) -> dict[str, Callable[..., Any]]:
        """Return the seven tool names mapped to their callables."""
        names = (
            "memory_search",
            "memory_recall",
            "memory_add",
            "memory_update",
            "memory_supersede",
            "memory_retract",
            "memory_journal",
        )
        return {name: getattr(self, name) for name in names}
