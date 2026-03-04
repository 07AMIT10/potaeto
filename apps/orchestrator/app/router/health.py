"""
ProviderHealthTracker — In-memory health state for smart model routing.

Design principles:
  1. Track per-(provider, model_key) health, not just per-provider, because
     different models on the same provider can have different rate limits.
  2. Detect 429/rate-limit errors specifically and apply a cooldown window
     that grows exponentially. Other errors (500, network) use a separate
     shorter backoff so we don't blacklist a provider for a transient glitch.
  3. During cooldown, the model is SKIPPED (not retried), so requests
     immediately fall through to the next-priority model instead of piling
     onto the rate-limited one and extending the cooldown.
  4. Track a rolling success rate over a recent window. Models below a
     health threshold get deprioritized (sorted after healthy ones).
  5. Expose a snapshot dict for the admin health API.

Rate-limit specifics from research:
  - Gemini: 429 RESOURCE_EXHAUSTED, retry-after header, RPM/TPM/RPD
  - Groq:   429 Too Many Requests, retry-after header, RPM/TPM/RPD
  - HF:     429 Too Many Requests, RateLimit header, per-5-min window
  All three return a retry-after-like header we can parse.

Algorithm — when selecting a model for a task:
  1. Load enabled models for task_type sorted by priority (from DB).
  2. Filter out models currently in cooldown (cooldown_until > now).
  3. Among remaining, sort by: (base_priority + health_penalty).
     - health_penalty = 0 if success_rate >= 90%
     - health_penalty = +50  if 50% <= success_rate < 90%
     - health_penalty = +200 if success_rate < 50%
     This means a priority-1 model with terrible health gets an effective
     priority of 201, so a healthy priority-10 model is tried first.
  4. Try models in this effective order. On success, record it.
  5. On 429 specifically: set cooldown_until = now + backoff.
     Backoff starts at 15s and doubles each consecutive 429 (capped at 5min).
     Non-429 errors: backoff starts at 3s, doubles, capped at 30s.
  6. On success: reset consecutive-error counter and decay cooldown base.
"""

from __future__ import annotations

import time
import threading
from dataclasses import dataclass, field


def _is_rate_limit_error(error_message: str) -> bool:
    """Detect 429 / rate-limit errors from exception messages."""
    lower = error_message.lower()
    return (
        "429" in lower
        or "rate" in lower and "limit" in lower
        or "resource_exhausted" in lower
        or "too many requests" in lower
        or "quota" in lower
    )


@dataclass
class ModelHealth:
    """Mutable health state for one (provider, model_key) pair."""

    provider: str
    model_key: str

    # Rolling window: last N outcomes (True=success, False=fail)
    recent_outcomes: list[bool] = field(default_factory=list)
    window_size: int = 30

    # Cooldown
    cooldown_until: float = 0.0  # monotonic timestamp
    consecutive_rate_limits: int = 0
    consecutive_errors: int = 0

    # Backoff config (seconds)
    rate_limit_base_backoff: float = 15.0
    rate_limit_max_backoff: float = 300.0  # 5 minutes
    error_base_backoff: float = 3.0
    error_max_backoff: float = 30.0

    # Lifetime counters
    total_calls: int = 0
    total_errors: int = 0
    total_rate_limits: int = 0

    @property
    def success_rate(self) -> float:
        if not self.recent_outcomes:
            return 1.0  # assume healthy if no data
        return sum(1 for o in self.recent_outcomes if o) / len(self.recent_outcomes)

    @property
    def is_cooling_down(self) -> bool:
        return time.monotonic() < self.cooldown_until

    @property
    def cooldown_remaining_sec(self) -> float:
        remaining = self.cooldown_until - time.monotonic()
        return max(0.0, remaining)

    @property
    def health_penalty(self) -> int:
        rate = self.success_rate
        if rate >= 0.90:
            return 0
        if rate >= 0.50:
            return 50
        return 200

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
            # Don't reset rate limit counter on non-rate errors
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
    """
    Thread-safe in-memory tracker. One instance per ModelRouter.
    Keyed by "provider:model_key".
    """

    def __init__(self) -> None:
        self._models: dict[str, ModelHealth] = {}
        self._lock = threading.Lock()

    def _key(self, provider: str, model_key: str) -> str:
        return f"{provider}:{model_key}"

    def _get_or_create(self, provider: str, model_key: str) -> ModelHealth:
        key = self._key(provider, model_key)
        with self._lock:
            if key not in self._models:
                self._models[key] = ModelHealth(provider=provider, model_key=model_key)
            return self._models[key]

    def record_success(self, provider: str, model_key: str) -> None:
        self._get_or_create(provider, model_key).record_success()

    def record_error(self, provider: str, model_key: str, error_message: str) -> None:
        self._get_or_create(provider, model_key).record_error(error_message)

    def is_available(self, provider: str, model_key: str) -> bool:
        """True if the model is NOT in cooldown."""
        health = self._get_or_create(provider, model_key)
        return not health.is_cooling_down

    def get_health_penalty(self, provider: str, model_key: str) -> int:
        return self._get_or_create(provider, model_key).health_penalty

    def get_cooldown_remaining(self, provider: str, model_key: str) -> float:
        return self._get_or_create(provider, model_key).cooldown_remaining_sec

    def snapshot_all(self) -> list[dict]:
        """Return health snapshots for all tracked models (for admin API)."""
        with self._lock:
            return [h.snapshot() for h in self._models.values()]
