"""Active-model selection shared by startup and the authenticated API.

The model picker persists its choice in the ``settings`` table so it survives a
restart. Startup prefers the stored selection over ``POTAETO_MODEL``; an
operator can still pin a model with the environment variable by clearing the
stored row (the CLI/docs describe the precedence).
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from typing import Any

from app.db.repositories.base import dump_json, fetch_one, load_json, transaction
from app.providers.registry import ProviderChoice, first_model_info

logger = logging.getLogger(__name__)

ACTIVE_MODEL_KEY = "active_model"
#: Catalogs are network-backed; startup and the picker must not hang a request
#: on a slow provider. A timeout keeps the fallback order usable.
CATALOG_TIMEOUT_SEC = 3.0


def read_active_selection(conn: sqlite3.Connection) -> tuple[str, str] | None:
    """Return ``(model, provider)`` from the settings table, if present."""
    row = fetch_one(
        conn, "SELECT value_json FROM settings WHERE key = ?", (ACTIVE_MODEL_KEY,)
    )
    if row is None:
        return None
    value = load_json(row["value_json"])
    if not isinstance(value, dict):
        return None
    model = str(value.get("model") or "").strip()
    if not model:
        return None
    return model, str(value.get("provider") or "").strip()


def write_active_selection(
    conn: sqlite3.Connection, model: str, provider: str = ""
) -> None:
    """Persist the picker's choice for the next startup."""
    with transaction(conn):
        conn.execute(
            """
            INSERT INTO settings (key, value_json) VALUES (?, ?)
            ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
            """,
            (ACTIVE_MODEL_KEY, dump_json({"model": model, "provider": provider})),
        )


async def select_providers(
    registry: Any,
    model: str,
    provider: str = "",
    *,
    timeout: float = CATALOG_TIMEOUT_SEC,
) -> list[ProviderChoice]:
    """Resolve the model against the catalog, falling back to registration order.

    A registry without a ``select`` method (tests) degrades to its registered
    providers with no catalog metadata, so model support remains permissive.
    """
    select = getattr(registry, "select", None)
    names = registry.names() if hasattr(registry, "names") else []
    if callable(select):
        try:
            return await asyncio.wait_for(
                select(model, provider or None), timeout=timeout
            )
        except TimeoutError:
            logger.warning(
                "provider catalog lookup for %r timed out after %.1fs; "
                "using registration order",
                model,
                timeout,
            )
        except Exception as exc:  # noqa: BLE001 - catalog failure is non-fatal
            logger.warning(
                "provider catalog lookup for %r failed (%s: %s); using registration order",
                model,
                type(exc).__name__,
                exc,
            )
    return [
        ProviderChoice(registry.get(name))
        for name in names
        if registry.get(name) is not None
    ]


async def apply_model_selection(
    app: Any, model: str, provider: str = ""
) -> list[ProviderChoice]:
    """Point the running app at ``model`` and refresh its provider candidates."""
    choices = await select_providers(app.state.providers, model, provider)
    app.state.model = model
    app.state.provider_candidates = choices
    app.state.model_info = first_model_info(choices)
    return choices
