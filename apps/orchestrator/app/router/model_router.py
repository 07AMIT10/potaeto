"""
Smart Model Router with health-aware provider selection.

Routing algorithm:
  1. Load enabled models for the task_type from DB, sorted by base priority.
  2. Partition into two lists:
     a) AVAILABLE — not currently in cooldown
     b) COOLING_DOWN — in cooldown (rate-limited or erroring)
  3. Sort AVAILABLE by effective_priority = base_priority + health_penalty.
     health_penalty is 0 for healthy (>=90% success), +50 for degraded,
     +200 for unhealthy (<50% success). This re-ranks without hard-removing.
  4. Try models from AVAILABLE in order. On success → done.
  5. If ALL available models fail, try COOLING_DOWN models as last resort
     (sorted by who has the least cooldown remaining — closest to recovery).
  6. On 429/rate-limit: exponential cooldown (15s → 30s → 60s → ... → 5min).
     On other errors: shorter cooldown (3s → 6s → 12s → ... → 30s).
     On success: reset consecutive counters.
  7. Log every attempt to model_usage_logs with metadata including
     effective_priority and whether the model was in cooldown.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal
import time

from supabase import create_client, Client

from app.config import get_settings
from app.providers.base import Provider, TextMessage, TextRequest, TextResponse
from app.providers.gemini import GeminiProvider
from app.providers.groq import GroqProvider
from app.providers.huggingface import HuggingFaceProvider
from app.router.health import ProviderHealthTracker


TaskType = Literal[
    "chat_primary", "summarize", "image_gen", "tts",
    "skill_text", "embedding", "proactive_message",
]


@dataclass
class ModelConfig:
    id: str
    provider: str
    model_key: str
    task_type: str
    temperature: float | None
    max_output_tokens: int | None
    priority: int


class ModelRouter:
    def __init__(self) -> None:
        settings = get_settings()
        self._supabase: Client = create_client(settings.supabase.url, settings.supabase.anon_key)

        providers: dict[str, Provider] = {
            "gemini": GeminiProvider(),
        }
        try:
            providers["groq"] = GroqProvider()
        except Exception:
            ...
        try:
            providers["huggingface"] = HuggingFaceProvider()
        except Exception:
            ...
        self._providers = providers

        self._health = ProviderHealthTracker()

    @property
    def health(self) -> ProviderHealthTracker:
        """Expose health tracker for the admin health endpoint."""
        return self._health

    # ── model loading ────────────────────────────────────────────────

    async def _load_models_for_task(self, task_type: TaskType) -> list[ModelConfig]:
        resp = (
            self._supabase.table("models_config")
            .select("id,provider,model_key,task_type,temperature,max_output_tokens,priority,enabled")
            .eq("task_type", task_type)
            .eq("enabled", True)
            .order("priority")
            .execute()
        )
        return [
            ModelConfig(
                id=row["id"],
                provider=row["provider"],
                model_key=row["model_key"],
                task_type=row["task_type"],
                temperature=row.get("temperature"),
                max_output_tokens=row.get("max_output_tokens"),
                priority=row.get("priority") or 100,
            )
            for row in (resp.data or [])
        ]

    # ── smart ordering ───────────────────────────────────────────────

    def _rank_models(self, models: list[ModelConfig]) -> tuple[list[ModelConfig], list[ModelConfig]]:
        """
        Split models into (available, cooling_down) and sort each list
        by effective priority.
        """
        available: list[tuple[int, ModelConfig]] = []
        cooling: list[tuple[float, ModelConfig]] = []

        for m in models:
            if self._providers.get(m.provider) is None:
                continue

            if self._health.is_available(m.provider, m.model_key):
                penalty = self._health.get_health_penalty(m.provider, m.model_key)
                effective = m.priority + penalty
                available.append((effective, m))
            else:
                remaining = self._health.get_cooldown_remaining(m.provider, m.model_key)
                cooling.append((remaining, m))

        available.sort(key=lambda x: x[0])
        cooling.sort(key=lambda x: x[0])  # shortest remaining cooldown first

        return (
            [m for _, m in available],
            [m for _, m in cooling],
        )

    # ── logging ──────────────────────────────────────────────────────

    def _log_usage(
        self,
        model: ModelConfig,
        success: bool,
        latency_ms: int | None,
        error_message: str | None = None,
        metadata: dict | None = None,
    ) -> None:
        try:
            self._supabase.table("model_usage_logs").insert(
                {
                    "task_type": model.task_type,
                    "provider": model.provider,
                    "model_key": model.model_key,
                    "success": success,
                    "latency_ms": latency_ms,
                    "error_message": error_message,
                    "metadata": metadata or {},
                }
            ).execute()
        except Exception:
            ...

    # ── core generation ──────────────────────────────────────────────

    async def generate_text(
        self,
        task_type: TaskType,
        messages: list[TextMessage],
    ) -> TextResponse:
        models = await self._load_models_for_task(task_type)
        if not models:
            raise RuntimeError(f"No models configured for task_type={task_type}")

        available, cooling = self._rank_models(models)

        # Try available (healthy) models first, then cooling-down as last resort
        ordered = available + cooling
        if not ordered:
            raise RuntimeError(f"No reachable providers for task_type={task_type}")

        last_error: Exception | None = None
        for model in ordered:
            provider = self._providers[model.provider]
            was_cooling = model in cooling
            penalty = self._health.get_health_penalty(model.provider, model.model_key)
            started = time.monotonic()

            try:
                req = TextRequest(
                    model_key=model.model_key,
                    messages=messages,
                    temperature=model.temperature,
                    max_tokens=model.max_output_tokens,
                )
                resp = await provider.generate_text(req)
                elapsed_ms = int((time.monotonic() - started) * 1000)

                self._health.record_success(model.provider, model.model_key)
                self._log_usage(
                    model=model, success=True, latency_ms=elapsed_ms,
                    metadata={
                        "effective_priority": model.priority + penalty,
                        "was_cooling_down": was_cooling,
                    },
                )
                return resp

            except Exception as exc:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                err_msg = str(exc)[:500]

                self._health.record_error(model.provider, model.model_key, err_msg)
                self._log_usage(
                    model=model, success=False, latency_ms=elapsed_ms,
                    error_message=err_msg,
                    metadata={
                        "effective_priority": model.priority + penalty,
                        "was_cooling_down": was_cooling,
                    },
                )
                last_error = exc
                continue

        raise RuntimeError(f"All providers failed for task_type={task_type}") from last_error

    async def generate_text_stream(
        self,
        task_type: TaskType,
        messages: list[TextMessage],
    ) -> AsyncIterator[str]:
        models = await self._load_models_for_task(task_type)
        if not models:
            raise RuntimeError(f"No models configured for task_type={task_type}")

        available, cooling = self._rank_models(models)
        ordered = available + cooling
        if not ordered:
            raise RuntimeError(f"No reachable providers for task_type={task_type}")

        last_error: Exception | None = None
        for model in ordered:
            provider = self._providers[model.provider]
            was_cooling = model in cooling
            penalty = self._health.get_health_penalty(model.provider, model.model_key)
            started = time.monotonic()

            try:
                req = TextRequest(
                    model_key=model.model_key,
                    messages=messages,
                    temperature=model.temperature,
                    max_tokens=model.max_output_tokens,
                )
                stream_method = getattr(provider, "generate_text_stream", None)
                if callable(stream_method):
                    full_content: list[str] = []
                    async for chunk in stream_method(req):
                        full_content.append(chunk)
                        yield chunk
                    elapsed_ms = int((time.monotonic() - started) * 1000)
                    self._health.record_success(model.provider, model.model_key)
                    self._log_usage(
                        model=model, success=True, latency_ms=elapsed_ms,
                        metadata={"effective_priority": model.priority + penalty, "was_cooling_down": was_cooling},
                    )
                    return

                resp = await provider.generate_text(req)
                elapsed_ms = int((time.monotonic() - started) * 1000)
                self._health.record_success(model.provider, model.model_key)
                self._log_usage(
                    model=model, success=True, latency_ms=elapsed_ms,
                    metadata={"effective_priority": model.priority + penalty, "was_cooling_down": was_cooling},
                )
                if resp.content:
                    yield resp.content
                return

            except Exception as exc:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                err_msg = str(exc)[:500]
                self._health.record_error(model.provider, model.model_key, err_msg)
                self._log_usage(
                    model=model, success=False, latency_ms=elapsed_ms,
                    error_message=err_msg,
                    metadata={"effective_priority": model.priority + penalty, "was_cooling_down": was_cooling},
                )
                last_error = exc
                continue

        raise RuntimeError(f"All providers failed for task_type={task_type}") from last_error
