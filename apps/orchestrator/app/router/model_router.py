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


TaskType = Literal["chat_primary", "summarize", "image_gen", "tts", "skill_text", "embedding"]


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
        # provider registry; HF / Groq are optional and registered only if configured.
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

    async def _load_models_for_task(self, task_type: TaskType) -> list[ModelConfig]:
        resp = self._supabase.table("models_config").select(
            "id,provider,model_key,task_type,temperature,max_output_tokens,priority,enabled"
        ).eq("task_type", task_type).eq("enabled", True).order("priority").execute()

        rows = resp.data or []
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
            for row in rows
        ]

    def _log_usage(
        self,
        model: ModelConfig,
        success: bool,
        latency_ms: int | None,
        error_message: str | None = None,
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
                }
            ).execute()
        except Exception:
            # Logging failures should never break the main flow.
            ...

    async def generate_text(
        self,
        task_type: TaskType,
        messages: list[TextMessage],
    ) -> TextResponse:
        models = await self._load_models_for_task(task_type)
        if not models:
            raise RuntimeError(f"No models configured for task_type={task_type}")

        last_error: Exception | None = None
        for model in models:
            provider = self._providers.get(model.provider)
            if not provider:
                continue
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
                self._log_usage(model=model, success=True, latency_ms=elapsed_ms, error_message=None)
                return resp
            except Exception as exc:  # noqa: BLE001
                elapsed_ms = int((time.monotonic() - started) * 1000)
                self._log_usage(
                    model=model,
                    success=False,
                    latency_ms=elapsed_ms,
                    error_message=str(exc)[:500],
                )
                last_error = exc
                continue

        raise RuntimeError(f"All providers failed for task_type={task_type}") from last_error

    async def generate_text_stream(
        self,
        task_type: TaskType,
        messages: list[TextMessage],
    ) -> AsyncIterator[str]:
        """Stream text chunks. Uses provider's generate_text_stream if available, else yields full response."""
        models = await self._load_models_for_task(task_type)
        if not models:
            raise RuntimeError(f"No models configured for task_type={task_type}")

        last_error: Exception | None = None
        for model in models:
            provider = self._providers.get(model.provider)
            if not provider:
                continue
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
                    self._log_usage(model=model, success=True, latency_ms=elapsed_ms, error_message=None)
                    return
                # No streaming: get full response and yield once
                resp = await provider.generate_text(req)
                elapsed_ms = int((time.monotonic() - started) * 1000)
                self._log_usage(model=model, success=True, latency_ms=elapsed_ms, error_message=None)
                if resp.content:
                    yield resp.content
                return
            except Exception as exc:  # noqa: BLE001
                elapsed_ms = int((time.monotonic() - started) * 1000)
                self._log_usage(
                    model=model,
                    success=False,
                    latency_ms=elapsed_ms,
                    error_message=str(exc)[:500],
                )
                last_error = exc
                continue

        raise RuntimeError(f"All providers failed for task_type={task_type}") from last_error

