"""Build an :class:`AgentLoop` from resolved provider candidates.

Both the HTTP chat route and the Telegram bot construct a loop per turn. Keeping
the selection here means they agree on failover order, the chosen model's tool
capability, and the context budget derived from its catalog window.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from app.agent.context import compute_context_budget
from app.agent.loop import AgentLoop, TurnQueue
from app.config import Settings
from app.providers.registry import (
    ProviderChoice,
    build_provider,
    first_model_info,
)


def choices_from_state(state: Any) -> list[ProviderChoice]:
    """Return resolved candidates, or a registration-order fallback.

    ``provider_candidates`` is populated at startup (and by the model picker).
    Tests and boot-failure paths may only have a registry, so every registered
    provider becomes a candidate with unknown catalog metadata.
    """
    choices = getattr(state, "provider_candidates", None) or []
    if choices:
        return list(choices)
    registry = getattr(state, "providers", None)
    names = registry.names() if registry is not None else []
    return [
        ProviderChoice(registry.get(name))
        for name in names
        if registry.get(name) is not None
    ]


def build_agent_loop(
    db: sqlite3.Connection,
    choices: list[ProviderChoice],
    model: str,
    *,
    queue: TurnQueue | None = None,
    max_tokens: int | None = None,
    settings: Settings | None = None,
) -> AgentLoop:
    """Construct a loop for the selected model, honoring its catalog entry."""
    if not choices:
        raise LookupError("no provider configured")
    resolved = settings or Settings()
    info = first_model_info(choices)
    context_budget = compute_context_budget(
        info.context_length if info else None,
        resolved.max_output_tokens,
        resolved.context_ceiling_tokens,
        resolved.context_floor_tokens,
    )
    return AgentLoop(
        db,
        build_provider(choices),
        model=model,
        queue=queue,
        max_tokens=max_tokens,
        context_budget=context_budget,
        memory_scope=resolved.memory_scope,
        supports_tools=None if info is None else info.supports_tools,
    )
