"""Arduino hardware tools exposed to the agent and API routers.

Provides LED control (solid, blink, breathe), sensor telemetry readout,
and preset behavioral patterns (alert, thinking, idle, success).
"""

from __future__ import annotations

import logging
from typing import Any

from app.hardware.arduino import ArduinoBridge

logger = logging.getLogger(__name__)

# Global default bridge instance, configured during orchestrator startup
_default_bridge: ArduinoBridge | None = None


def get_default_bridge() -> ArduinoBridge:
    """Return the global ArduinoBridge instance, creating a fallback if unset."""
    global _default_bridge
    if _default_bridge is None:
        _default_bridge = ArduinoBridge()
    return _default_bridge


def set_default_bridge(bridge: ArduinoBridge | None) -> None:
    """Explicitly assign the active ArduinoBridge instance."""
    global _default_bridge
    _default_bridge = bridge


class AwaitableDict(dict[str, Any]):
    """A dictionary that can be used directly or awaited."""

    def __await__(self) -> Any:
        async def _wrap() -> AwaitableDict:
            return self

        return _wrap().__await__()


PRESET_PATTERNS: dict[str, dict[str, Any]] = {
    "alert": {"r": 255, "g": 0, "b": 0, "pattern": "blink"},
    "thinking": {"r": 0, "g": 180, "b": 255, "pattern": "breathe"},
    "idle": {"r": 0, "g": 128, "b": 0, "pattern": "breathe"},
    "success": {"r": 0, "g": 255, "b": 0, "pattern": "solid"},
}


async def arduino_led(
    r: int,
    g: int,
    b: int,
    pattern: str = "solid",
    *,
    bridge: ArduinoBridge | None = None,
) -> dict[str, Any]:
    """Set Arduino RGB LED color and pattern (solid, blink, breathe).

    Active-low hardware inversion is handled transparently by the bridge:
    callers provide software brightness (0 = off, 255 = full bright).
    """
    b_inst = bridge or get_default_bridge()
    if not b_inst.is_connected:
        return {"ok": False, "error": "Arduino not connected"}

    result = await b_inst.set_led(r=r, g=g, b=b, pattern=pattern)
    return result


def arduino_read(
    *,
    bridge: ArduinoBridge | None = None,
) -> AwaitableDict:
    """Return the latest sensor telemetry readings.

    Fields include temperature (°C), humidity (%), pressure (hPa), light,
    and 3-axis accelerometer values.
    """
    b_inst = bridge or get_default_bridge()
    if not b_inst.is_connected:
        return AwaitableDict({"ok": False, "error": "Arduino not connected"})

    latest = b_inst.latest_telemetry
    if not latest:
        return AwaitableDict({
            "ok": True,
            "connected": True,
            "temperature": None,
            "humidity": None,
            "pressure": None,
            "light": None,
            "accelerometer": None,
        })

    temp = latest.get("temp") if latest.get("temp") is not None else latest.get("temperature")
    hum = latest.get("hum") if latest.get("hum") is not None else latest.get("humidity")
    press = latest.get("press") if latest.get("press") is not None else latest.get("pressure")
    light = latest.get("light")
    acc = latest.get("acc") if latest.get("acc") is not None else latest.get("accelerometer")

    out: dict[str, Any] = {
        "ok": True,
        "connected": True,
        "temperature": temp,
        "humidity": hum,
        "pressure": press,
        "light": light,
        "accelerometer": acc,
        "temp": temp,
        "hum": hum,
        "press": press,
        "acc": acc,
    }
    return AwaitableDict(out)


async def arduino_pattern(
    name: str,
    *,
    bridge: ArduinoBridge | None = None,
) -> dict[str, Any]:
    """Trigger a preset behavioral pattern (e.g. alert, thinking, idle, success)."""
    b_inst = bridge or get_default_bridge()
    if not b_inst.is_connected:
        return {"ok": False, "error": "Arduino not connected"}

    preset = PRESET_PATTERNS.get(name.lower())
    if preset is None:
        available = ", ".join(sorted(PRESET_PATTERNS.keys()))
        return {
            "ok": False,
            "error": f"Unknown preset pattern: '{name}'. Available presets: {available}",
        }

    res = await b_inst.set_led(
        r=preset["r"],
        g=preset["g"],
        b=preset["b"],
        pattern=preset["pattern"],
    )
    if isinstance(res, dict) and res.get("ok"):
        res = dict(res)
        res["preset"] = name.lower()
    return res


class ArduinoTools:
    """Tool wrapper exposing Arduino operations to the agent loop."""

    def __init__(self, bridge: ArduinoBridge | None = None) -> None:
        self.bridge = bridge

    async def arduino_led(
        self, r: int, g: int, b: int, pattern: str = "solid"
    ) -> dict[str, Any]:
        return await arduino_led(r, g, b, pattern, bridge=self.bridge)

    def arduino_read(self) -> dict[str, Any]:
        return arduino_read(bridge=self.bridge)

    async def arduino_pattern(self, name: str) -> dict[str, Any]:
        return await arduino_pattern(name, bridge=self.bridge)

    def as_tool_map(self) -> dict[str, Any]:
        """Return the agent-facing tool dictionary."""
        return {
            "arduino_led": self.arduino_led,
            "arduino_read": self.arduino_read,
            "arduino_pattern": self.arduino_pattern,
        }
