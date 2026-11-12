"""A small in-memory token bucket for per-key request throttling.

The bucket state lives in this process only: the core runs as one systemd unit,
so a distributed limiter would add a dependency without buying anything. Keys
are device ids, chat ids, or any other short caller identifier.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

#: Cap on tracked keys so a hostile caller cannot grow the map without bound.
DEFAULT_MAX_KEYS = 4096


@dataclass
class _Bucket:
    tokens: float
    capacity: float
    updated: float


class RateLimiter:
    """Token bucket keyed by caller, refilling at ``limit / window_sec``."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = DEFAULT_MAX_KEYS,
    ) -> None:
        self._clock = clock
        self._max_keys = max(1, max_keys)
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_sec: float) -> bool:
        """Consume one token for `key`; return false when the bucket is empty.

        A bucket holds at most `limit` tokens and refills over `window_sec`, so
        at most `limit` calls pass in any window. Non-positive limits or
        windows deny every call rather than granting unlimited access.
        """
        if limit <= 0 or window_sec <= 0:
            return False

        now = self._clock()
        capacity = float(limit)
        rate = capacity / float(window_sec)
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=capacity, capacity=capacity, updated=now)
                self._evict()
                self._buckets[key] = bucket
            else:
                elapsed = max(0.0, now - bucket.updated)
                bucket.tokens = min(capacity, bucket.tokens + elapsed * rate)
                bucket.capacity = capacity
                bucket.updated = now

            if bucket.tokens < 1.0:
                return False
            bucket.tokens -= 1.0
            return True

    def _evict(self) -> None:
        """Make room for one key: drop idle full buckets, then the oldest."""
        if len(self._buckets) < self._max_keys:
            return
        for key in [
            key
            for key, bucket in self._buckets.items()
            if bucket.tokens >= bucket.capacity
        ]:
            del self._buckets[key]
        while len(self._buckets) >= self._max_keys:
            oldest = min(self._buckets, key=lambda key: self._buckets[key].updated)
            del self._buckets[oldest]
