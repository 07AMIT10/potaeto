"""Provider usage repository (tokens, cost, and allowance per model call)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row, new_id, transaction


@dataclass(frozen=True)
class ProviderUsage:
    id: str
    provider: str
    model_id: str
    task_type: str | None
    tokens_in: int
    tokens_out: int
    cost: float
    allowance_json: dict[str, Any]
    success: int
    latency_ms: int | None
    created_at: str


def normalize_usage(usage: dict[str, Any] | None) -> tuple[int, int, float, dict[str, Any]]:
    """Map provider usage fields to ``(tokens_in, tokens_out, cost, allowance)``.

    OpenAI/OpenRouter report ``prompt_tokens``/``completion_tokens``; native
    protocols use ``input_tokens``/``output_tokens``. Missing values are zero so
    a provider that omits usage still leaves a row for budget accounting.
    """
    usage = usage or {}
    tokens_in = _as_int(
        usage.get("prompt_tokens", usage.get("input_tokens", usage.get("tokens_in")))
    )
    tokens_out = _as_int(
        usage.get(
            "completion_tokens", usage.get("output_tokens", usage.get("tokens_out"))
        )
    )
    cost = _as_float(usage.get("cost", usage.get("total_cost")))
    allowance = usage.get("allowance")
    return tokens_in, tokens_out, cost, allowance if isinstance(allowance, dict) else {}


def _as_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


class UsageRepo(BaseRepo):
    table = "provider_usage"

    def _to_model(self, row) -> ProviderUsage:
        return from_row(ProviderUsage, row, ("allowance_json",))

    def record(
        self,
        provider: str,
        model_id: str,
        *,
        task_type: str | None = "chat",
        tokens_in: int = 0,
        tokens_out: int = 0,
        cost: float = 0.0,
        allowance: dict[str, Any] | None = None,
        success: bool = True,
        latency_ms: int | None = None,
        usage_id: str | None = None,
    ) -> ProviderUsage:
        identifier = usage_id or new_id("pu")
        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO provider_usage (
                    id, provider, model_id, task_type, tokens_in, tokens_out, cost,
                    allowance_json, success, latency_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    provider,
                    model_id,
                    task_type,
                    tokens_in,
                    tokens_out,
                    cost,
                    dump_json(allowance or {}),
                    1 if success else 0,
                    latency_ms,
                ),
            )
        return self.get(identifier)

    def get(self, usage_id: str) -> ProviderUsage | None:
        row = self._one("SELECT * FROM provider_usage WHERE id = ?", (usage_id,))
        return None if row is None else self._to_model(row)

    def list(self, *, provider: str | None = None, limit: int = 100) -> list[ProviderUsage]:
        clauses: list[str] = []
        params: list[Any] = []
        if provider is not None:
            clauses.append("provider = ?")
            params.append(provider)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        rows = self._all(
            f"SELECT * FROM provider_usage{where} ORDER BY created_at DESC, rowid DESC LIMIT ?",
            params,
        )
        return [self._to_model(row) for row in rows]

    def summary(self) -> dict[str, Any]:
        """Aggregate total and per-provider / per-model usage statistics."""
        def _get(row: Any, key: str, idx: int, default: Any = 0) -> Any:
            if row is None:
                return default
            try:
                return row[key]
            except (TypeError, KeyError, IndexError):
                if isinstance(row, (tuple, list)) and len(row) > idx:
                    return row[idx]
                return default

        tot_row = self._one(
            """
            SELECT
                COALESCE(SUM(tokens_in), 0) AS total_tokens_in,
                COALESCE(SUM(tokens_out), 0) AS total_tokens_out,
                COALESCE(SUM(cost), 0.0) AS total_cost,
                COUNT(*) AS call_count
            FROM provider_usage
            """
        )
        total_tokens_in = int(_get(tot_row, "total_tokens_in", 0, 0))
        total_tokens_out = int(_get(tot_row, "total_tokens_out", 1, 0))
        total_cost = round(float(_get(tot_row, "total_cost", 2, 0.0)), 6)
        call_count = int(_get(tot_row, "call_count", 3, 0))

        prov_rows = self._all(
            """
            SELECT
                provider,
                COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(cost), 0.0) AS cost,
                COUNT(*) AS call_count
            FROM provider_usage
            GROUP BY provider
            ORDER BY provider
            """
        )
        by_provider: dict[str, dict[str, Any]] = {}
        for r in prov_rows:
            p_name = str(_get(r, "provider", 0, ""))
            if p_name:
                by_provider[p_name] = {
                    "tokens_in": int(_get(r, "tokens_in", 1, 0)),
                    "tokens_out": int(_get(r, "tokens_out", 2, 0)),
                    "cost": round(float(_get(r, "cost", 3, 0.0)), 6),
                    "call_count": int(_get(r, "call_count", 4, 0)),
                }

        model_rows = self._all(
            """
            SELECT
                model_id,
                COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(cost), 0.0) AS cost,
                COUNT(*) AS call_count
            FROM provider_usage
            GROUP BY model_id
            ORDER BY model_id
            """
        )
        by_model: dict[str, dict[str, Any]] = {}
        for r in model_rows:
            m_name = str(_get(r, "model_id", 0, ""))
            if m_name:
                by_model[m_name] = {
                    "tokens_in": int(_get(r, "tokens_in", 1, 0)),
                    "tokens_out": int(_get(r, "tokens_out", 2, 0)),
                    "cost": round(float(_get(r, "cost", 3, 0.0)), 6),
                    "call_count": int(_get(r, "call_count", 4, 0)),
                }

        return {
            "total_tokens_in": total_tokens_in,
            "total_tokens_out": total_tokens_out,
            "total_cost": total_cost,
            "call_count": call_count,
            "by_provider": by_provider,
            "by_model": by_model,
        }
