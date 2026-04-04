"""
Smart Model Router with config-driven providers, models_config caching,
and health-aware selection.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal
import time

from supabase import create_client, Client

from app.config import get_settings
from app.providers.base import Provider, TextMessage, TextRequest, TextResponse
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


def _build_provider_registry(enabled: list[str]) -> dict[str, Provider]:
    """Lazy-load only the providers listed in ENABLED_PROVIDERS."""
    registry: dict[str, Provider] = {}
    for name in enabled:
        try:
            if name == "gemini":
                from app.providers.gemini import GeminiProvider
                registry["gemini"] = GeminiProvider()
            elif name == "groq":
                from app.providers.groq import GroqProvider
                registry["groq"] = GroqProvider()
            elif name == "cerebras":
                from app.providers.cerebras import CerebrasProvider
                registry["cerebras"] = CerebrasProvider()
            elif name == "sambanova":
                from app.providers.sambanova import SambaNovaProvider
                registry["sambanova"] = SambaNovaProvider()
            elif name == "openrouter":
                from app.providers.openrouter import OpenRouterProvider
                registry["openrouter"] = OpenRouterProvider()
            elif name == "huggingface":
                from app.providers.huggingface import HuggingFaceProvider
                registry["huggingface"] = HuggingFaceProvider()
        except Exception:
            ...
    return registry


class _ModelsCache:
    """TTL cache for models_config to avoid hitting Supabase on every request."""

    def __init__(self, supabase: Client, ttl_sec: int, default_priority: int) -> None:
        self._supabase = supabase
        self._ttl = ttl_sec
        self._default_priority = default_priority
        self._cache: dict[str, tuple[float, list[ModelConfig]]] = {}

    def get(self, task_type: str) -> list[ModelConfig]:
        now = time.monotonic()
        cached = self._cache.get(task_type)
        if cached and (now - cached[0]) < self._ttl:
            return cached[1]

        resp = (
            self._supabase.table("models_config")
            .select("id,provider,model_key,task_type,temperature,max_output_tokens,priority,enabled")
            .eq("task_type", task_type)
            .eq("enabled", True)
            .order("priority")
            .execute()
        )
        models = [
            ModelConfig(
                id=row["id"],
                provider=row["provider"],
                model_key=row["model_key"],
                task_type=row["task_type"],
                temperature=row.get("temperature"),
                max_output_tokens=row.get("max_output_tokens"),
                priority=row.get("priority") or self._default_priority,
            )
            for row in (resp.data or [])
        ]
        self._cache[task_type] = (now, models)
        return models

    def invalidate(self, task_type: str | None = None) -> None:
        if task_type:
            self._cache.pop(task_type, None)
        else:
            self._cache.clear()


class ModelRouter:
    def __init__(self) -> None:
        settings = get_settings()
        key = settings.supabase.service_role_key or settings.supabase.anon_key
        self._supabase: Client = create_client(settings.supabase.url, key)
        self._providers = _build_provider_registry(settings.routing.enabled_providers)
        self._health = ProviderHealthTracker(health_settings=settings.health)
        self._models_cache = _ModelsCache(
            supabase=self._supabase,
            ttl_sec=settings.routing.models_config_cache_ttl_sec,
            default_priority=settings.routing.default_priority,
        )
        self._err_max_len = settings.health.error_message_max_len

    @property
    def health(self) -> ProviderHealthTracker:
        return self._health

    def invalidate_cache(self, task_type: str | None = None) -> None:
        """Call after admin changes models_config so new config takes effect."""
        self._models_cache.invalidate(task_type)

    # ── smart ordering ───────────────────────────────────────────────

    def _rank_models(self, models: list[ModelConfig]) -> tuple[list[ModelConfig], list[ModelConfig]]:
        available: list[tuple[int, ModelConfig]] = []
        cooling: list[tuple[float, ModelConfig]] = []

        for m in models:
            if m.provider not in self._providers:
                continue
            if self._health.is_available(m.provider, m.model_key):
                penalty = self._health.get_health_penalty(m.provider, m.model_key)
                available.append((m.priority + penalty, m))
            else:
                remaining = self._health.get_cooldown_remaining(m.provider, m.model_key)
                cooling.append((remaining, m))

        available.sort(key=lambda x: x[0])
        cooling.sort(key=lambda x: x[0])
        return ([m for _, m in available], [m for _, m in cooling])

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
        models = self._models_cache.get(task_type)
        if not models:
            raise RuntimeError(f"No models configured for task_type={task_type}")

        available, cooling = self._rank_models(models)
        ordered = available + cooling
        if not ordered:
            raise RuntimeError(f"No reachable providers for task_type={task_type}")

        last_error: Exception | None = None
        for model in ordered:
            provider = self._providers[model.provider]
            was_cooling = model not in available
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
                    metadata={"effective_priority": model.priority + penalty, "was_cooling_down": was_cooling},
                )
                return resp
            except Exception as exc:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                err_msg = str(exc)[: self._err_max_len]
                self._health.record_error(model.provider, model.model_key, err_msg)
                self._log_usage(
                    model=model, success=False, latency_ms=elapsed_ms,
                    error_message=err_msg,
                    metadata={"effective_priority": model.priority + penalty, "was_cooling_down": was_cooling},
                )
                last_error = exc

        raise RuntimeError(f"All providers failed for task_type={task_type}") from last_error

    async def generate_text_stream(
        self,
        task_type: TaskType,
        messages: list[TextMessage],
    ) -> AsyncIterator[str]:
        models = self._models_cache.get(task_type)
        if not models:
            raise RuntimeError(f"No models configured for task_type={task_type}")

        available, cooling = self._rank_models(models)
        ordered = available + cooling
        if not ordered:
            raise RuntimeError(f"No reachable providers for task_type={task_type}")

        last_error: Exception | None = None
        for model in ordered:
            provider = self._providers[model.provider]
            was_cooling = model not in available
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
                    async for chunk in stream_method(req):
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
                err_msg = str(exc)[: self._err_max_len]
                self._health.record_error(model.provider, model.model_key, err_msg)
                self._log_usage(
                    model=model, success=False, latency_ms=elapsed_ms,
                    error_message=err_msg,
                    metadata={"effective_priority": model.priority + penalty, "was_cooling_down": was_cooling},
                )
                last_error = exc

        raise RuntimeError(f"All providers failed for task_type={task_type}") from last_error
