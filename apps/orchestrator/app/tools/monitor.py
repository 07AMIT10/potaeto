"""Read-only host and network monitors exposed to the agent.

Both observations are best-effort: a missing sensor, an unreadable ``/proc``
file, or an unreachable URL degrades to ``None`` (or an error field) instead of
raising into the agent loop.
"""

from __future__ import annotations

import shutil
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from app.audit import audit_safely
from app.security.ssrf import SSRFError, redact_url, validate_url

_PROC_LOADAVG = "/proc/loadavg"
_PROC_MEMINFO = "/proc/meminfo"
_THERMAL_ROOT = "/sys/class/thermal"
_PING_TIMEOUT_SEC = 5.0

#: Zone types that report the CPU package rather than an ACPI thermal trip
#: point. `x86_pkg_temp` is usually a higher-numbered zone than `acpitz`.
_CPU_ZONE_TYPES = ("x86_pkg_temp", "cpu-thermal", "soc_thermal", "tcpu")


def _read_text(path: str) -> str | None:
    """Read a small pseudo-file, or return ``None`` when it is unavailable."""
    try:
        return Path(path).read_text(encoding="ascii", errors="replace")
    except OSError:
        return None


def _thermal_readings(root: str = _THERMAL_ROOT) -> list[tuple[str, float]]:
    """Return ``(zone_type, celsius)`` for every readable positive zone."""
    readings: list[tuple[str, float]] = []
    try:
        zones = sorted(Path(root).glob("thermal_zone*"))
    except OSError:
        return readings
    for zone in zones:
        zone_type = (_read_text(str(zone / "type")) or "").strip()
        text = _read_text(str(zone / "temp"))
        if not text:
            continue
        try:
            millidegrees = float(text.strip())
        except ValueError:
            continue
        if millidegrees > 0:
            readings.append((zone_type, millidegrees / 1000))
    return readings


def _cpu_temp_c(root: str = _THERMAL_ROOT) -> float | None:
    """Return the CPU package temperature, preferring a real CPU zone.

    Falls back to any positive zone when the preferred types are absent, so
    hosts without `x86_pkg_temp` still report something useful.
    """
    readings = _thermal_readings(root)
    for preferred in _CPU_ZONE_TYPES:
        for zone_type, celsius in readings:
            if zone_type.casefold() == preferred:
                return round(celsius, 1)
    if readings:
        return round(readings[0][1], 1)
    return None


def _load_1m() -> float | None:
    text = _read_text(_PROC_LOADAVG)
    if not text:
        return None
    try:
        return float(text.split()[0])
    except (IndexError, ValueError):
        return None


def _mem_available_mb() -> float | None:
    text = _read_text(_PROC_MEMINFO)
    if not text:
        return None
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key != "MemAvailable":
            continue
        try:
            kib = float(rest.split()[0])
        except (IndexError, ValueError):
            return None
        return round(kib / 1024, 1)
    return None


def _disk_used_pct() -> float | None:
    try:
        usage = shutil.disk_usage("/")
    except OSError:
        return None
    if usage.total <= 0:
        return None
    return round(usage.used / usage.total * 100, 1)


def _safely(read: Callable[[], float | None]) -> float | None:
    """Run one sensor read; a monitor failure is never fatal to the caller."""
    try:
        return read()
    except Exception:  # noqa: BLE001 - monitors must never break the agent loop
        return None


class MonitorTools:
    """Host health and HTTP reachability, without side effects."""

    def __init__(
        self,
        db: sqlite3.Connection | None = None,
        *,
        ssrf_validator: Callable[[str], None] | None = None,
    ) -> None:
        self.db = db
        # Injectable so tests can exercise the HTTP path without DNS.
        self._ssrf_validator = ssrf_validator or validate_url

    def system_health(self) -> dict[str, float | None]:
        """Return CPU temperature, 1-minute load, available RAM, and disk use.

        Values that this host cannot report are ``None`` rather than zero, so a
        caller can tell "cool" apart from "sensor missing".
        """
        return {
            "cpu_temp_c": _safely(_cpu_temp_c),
            "load_1m": _safely(_load_1m),
            "mem_available_mb": _safely(_mem_available_mb),
            "disk_used_pct": _safely(_disk_used_pct),
        }

    def http_ping(
        self, url: str, *, timeout: float = _PING_TIMEOUT_SEC
    ) -> dict[str, Any]:
        """GET `url` once, reporting status and latency without following redirects.

        Redirects are surfaced (not followed) so a caller can see the 3xx. The
        destination is first checked with the SSRF policy so a compromised or
        prompt-injected agent cannot use the monitor to probe the LAN or cloud
        metadata. Network errors come back as ``status=None`` plus an ``error``
        string.
        """
        try:
            self._ssrf_validator(url)
        except SSRFError as exc:
            self._audit_block(url, exc)
            return self._error_result(url, f"SSRFError: {exc}")
        except (OSError, ValueError) as exc:
            return self._error_result(url, f"{type(exc).__name__}: {exc}")

        started = time.perf_counter()
        try:
            with httpx.Client(
                timeout=timeout, follow_redirects=False, trust_env=False
            ) as client:
                response = client.get(url)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
            return {
                "url": url,
                "status": None,
                "latency_ms": _elapsed_ms(started),
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        return {
            "url": url,
            "status": response.status_code,
            "latency_ms": _elapsed_ms(started),
            "ok": 200 <= response.status_code < 300,
            "error": None,
        }

    def _error_result(self, url: str, error: str) -> dict[str, Any]:
        return {
            "url": url,
            "status": None,
            "latency_ms": 0.0,
            "ok": False,
            "error": error,
        }

    def _audit_block(self, url: str, exc: SSRFError) -> None:
        audit_safely(
            self.db,
            None,
            "ssrf_blocked",
            redact_url(url),
            {"reason": exc.reason, "source": "http_ping"},
        )

    def as_tool_map(self) -> dict[str, Callable[..., Any]]:
        """Return the agent-facing names mapped to their read-only callables."""
        return {
            "system_health": self.system_health,
            "http_ping": self.http_ping,
        }


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)
