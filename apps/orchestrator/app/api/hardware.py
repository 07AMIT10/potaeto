"""Hardware API endpoints for Arduino telemetry and LED control."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.hardware.arduino import ArduinoBridge
from app.tools.arduino import get_default_bridge

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/hardware", tags=["hardware"])


class TelemetryResponse(BaseModel):
    connected: bool
    temperature: float | None = None
    humidity: float | None = None
    pressure: float | None = None
    light: float | int | None = None
    accelerometer: list[float] | None = None
    ok: bool = True


class LedControlRequest(BaseModel):
    r: int = Field(ge=0, le=255, description="Red channel (0-255)")
    g: int = Field(ge=0, le=255, description="Green channel (0-255)")
    b: int = Field(ge=0, le=255, description="Blue channel (0-255)")
    pattern: str | None = Field(default="solid", description="LED pattern: solid, breathe, blink")


class LedControlResponse(BaseModel):
    ok: bool
    error: str | None = None


def get_bridge() -> ArduinoBridge:
    """Return the active ArduinoBridge instance."""
    return get_default_bridge()


@router.get("/telemetry", response_model=TelemetryResponse)
def get_telemetry() -> TelemetryResponse:
    """Return latest sensor data (temperature, humidity, pressure, light, accelerometer, connected)."""
    bridge = get_bridge()
    connected = bridge.is_connected
    latest = bridge.latest_telemetry

    temp = latest.get("temp") if latest.get("temp") is not None else latest.get("temperature")
    hum = latest.get("hum") if latest.get("hum") is not None else latest.get("humidity")
    press = latest.get("press") if latest.get("press") is not None else latest.get("pressure")
    light = latest.get("light")
    acc = latest.get("acc") if latest.get("acc") is not None else latest.get("accelerometer")

    return TelemetryResponse(
        connected=connected,
        temperature=float(temp) if temp is not None else None,
        humidity=float(hum) if hum is not None else None,
        pressure=float(press) if press is not None else None,
        light=light,
        accelerometer=acc,
        ok=True,
    )


@router.post("/led", response_model=LedControlResponse)
async def set_led(request: LedControlRequest) -> LedControlResponse:
    """Accept RGB and optional pattern, call bridge to set LED color."""
    bridge = get_bridge()
    pattern = request.pattern or "solid"
    result = await bridge.set_led(r=request.r, g=request.g, b=request.b, pattern=pattern)
    return LedControlResponse(
        ok=bool(result.get("ok", False)),
        error=result.get("error"),
    )
