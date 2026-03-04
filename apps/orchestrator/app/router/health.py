"""
ProviderHealthTracker — In-memory health state for smart model routing.

All thresholds and backoff values are driven by HealthSettings from config.py.
See config.py HealthSettings for env var names.
"""

from __future__ import annotations

import time
import threading
from dataclasses import dataclass, field


def _is_rate_limit_error(error_message: str) -> bool:
    lower = error_message.lower()
    return (
        "429" in lower
        or ("rate" in lower and "limit" in lower)
        or "resource_exhausted" in lower
        or "too many requests" in lower
        or "quota" in lower
    )


@dataclass
class ModelHealth:
    provider: str
    model_key: str

    # Config (injected from HealthSettings)
    window_size: int = 30
    rate_limit_base_backoff: float = 15.0
    rate_limit_max_backoff: float = 300.0
    error_base_backoff: float = 3.0
    error_max_backoff: float = 30.0
    healthy_threshold: float = 0.90
    degraded_threshold: float = 0.50
    degraded_penalty: int = 50
    unhealthy_penalty: int = 200

    # State
    recent_outcomes: list[bool] = field(default_factory=list)
    cooldown_until: float = 0.0
    consecutive_rate_limits: int = 0
    consecutive_errors: int = 0
    total_calls: int = 0
    total_errors: int = 0
    total_rate_limits: int = 0

    @property
    def success_rate(self) -> float:
        if not self.recent_outcomes:
            return 1.0
        return sum(1 for o in self.recent_outcomes if o) / len(self.recent_outcomes)

    @property
    def is_cooling_down(self) -> bool:
        return time.monotonic() < self.cooldown_until

    @property
    def cooldown_remaining_sec(self) -> float:
        return max(0.0, self.cooldown_until - time.monotonic())

    @property
    def health_penalty(self) -> int:
        rate = self.success_rate
        if rate >= self.healthy_threshold:
            return 0
        if rate >= self.degraded_threshold:
            return self.degraded_penalty
        return self.unhealthy_penalty

    def record_success(self) -> None:
        self.total_calls += 1
        self.recent_outcomes.append(True)
        if len(self.recent_outcomes) > self.window_size:
            self.recent_outcomes = self.recent_outcomes[-self.window_size:]
        self.consecutive_rate_limits = 0
        self.consecutive_errors = 0

    def record_error(self, error_message: str) -> None:
        self.total_calls += 1
        self.total_errors += 1
        self.recent_outcomes.append(False)
        if len(self.recent_outcomes) > self.window_size:
            self.recent_outcomes = self.recent_outcomes[-self.window_size:]

        is_rate = _is_rate_limit_error(error_message)

        if is_rate:
            self.total_rate_limits += 1
            self.consecutive_rate_limits += 1
            self.consecutive_errors += 1
            backoff = min(
                self.rate_limit_base_backoff * (2 ** (self.consecutive_rate_limits - 1)),
                self.rate_limit_max_backoff,
            )
        else:
            self.consecutive_errors += 1
            backoff = min(
                self.error_base_backoff * (2 ** (self.consecutive_errors - 1)),
                self.error_max_backoff,
            )

        self.cooldown_until = time.monotonic() + backoff

    def snapshot(self) -> dict:
        return {
            "provider": self.provider,
            "model_key": self.model_key,
            "success_rate": round(self.success_rate * 100, 1),
            "is_cooling_down": self.is_cooling_down,
            "cooldown_remaining_sec": round(self.cooldown_remaining_sec, 1),
            "consecutive_rate_limits": self.consecutive_rate_limits,
            "consecutive_errors": self.consecutive_errors,
            "total_calls": self.total_calls,
            "total_errors": self.total_errors,
            "total_rate_limits": self.total_rate_limits,
            "health_penalty": self.health_penalty,
        }


class ProviderHealthTracker:
    def __init__(self, health_settings: object | None = None) -> None:
        self._models: dict[str, ModelHealth] = {}
        self._lock = threading.Lock()
        self._hs = health_settings

    def _get_or_create(self, provider: str, model_key: str) -> ModelHealth:
        key = f"{provider}:{model_key}"
        with self._lock:
            if key not in self._models:
                kwargs: dict = {"provider": provider, "model_key": model_key}
                if self._hs is not None:
                    kwargs["window_size"] = getattr(self._hs, "rolling_window_size", 30)
                    kwargs["rate_limit_base_backoff"] = getattr(self._hs, "rate_limit_base_backoff", 15.0)
                    kwargs["rate_limit_max_backoff"] = getattr(self._hs, "rate_limit_max_backoff", 300.0)
                    kwargs["error_base_backoff"] = getattr(self._hs, "error_base_backoff", 3.0)
                    kwargs["error_max_backoff"] = getattr(self._hs, "error_max_backoff", 30.0)
                    kwargs["healthy_threshold"] = getattr(self._hs, "healthy_threshold", 0.90)
                    kwargs["degraded_threshold"] = getattr(self._hs, "degraded_threshold", 0.50)
                    kwargs["degraded_penalty"] = getattr(self._hs, "degraded_penalty", 50)
                    kwargs["unhealthy_penalty"] = getattr(self._hs, "unhealthy_penalty", 200)
                self._models[key] = ModelHealth(**kwargs)
            return self._models[key]

    def record_success(self, provider: str, model_key: str) -> None:
        self._get_or_create(provider, model_key).record_success()

    def record_error(self, provider: str, model_key: str, error_message: str) -> None:
        self._get_or_create(provider, model_key).record_error(error_message)

    def is_available(self, provider: str, model_key: str) -> bool:
        return not self._get_or_create(provider, model_key).is_cooling_down

    def get_health_penalty(self, provider: str, model_key: str) -> int:
        return self._get_or_create(provider, model_key).health_penalty

    def get_cooldown_remaining(self, provider: str, model_key: str) -> float:
        return self._get_or_create(provider, model_key).cooldown_remaining_sec

    def snapshot_all(self) -> list[dict]:
        with self._lock:
            return [h.snapshot() for h in self._models.values()]
