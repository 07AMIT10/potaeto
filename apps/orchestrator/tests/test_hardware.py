"""Tests for Hardware Telemetry and LED Control API routes."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.hardware.arduino import ArduinoBridge
from app.tools.arduino import set_default_bridge


@pytest.fixture(autouse=True)
def clean_bridge():
    """Ensure clean bridge state around every test."""
    set_default_bridge(None)
    yield
    set_default_bridge(None)


def test_get_telemetry_disconnected(client):
    """GET /v1/hardware/telemetry reports connected=False when no hardware is attached."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = False
    set_default_bridge(bridge)

    res = client.get("/v1/hardware/telemetry")
    assert res.status_code == 200
    data = res.json()
    assert data["connected"] is False
    assert data["temperature"] is None
    assert data["humidity"] is None
    assert data["pressure"] is None
    assert data["light"] is None
    assert data["accelerometer"] is None
    assert data["ok"] is True


def test_get_telemetry_with_sensor_readings(client):
    """GET /v1/hardware/telemetry returns parsed sensor values when bridge has readings."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = True
    bridge.handle_line(json.dumps({
        "evt": "telemetry",
        "temp": 23.4,
        "hum": 48.7,
        "press": 1012.8,
        "light": 250,
        "acc": [0.05, -0.02, 9.81],
    }))
    set_default_bridge(bridge)

    res = client.get("/v1/hardware/telemetry")
    assert res.status_code == 200
    data = res.json()
    assert data["connected"] is True
    assert data["temperature"] == 23.4
    assert data["humidity"] == 48.7
    assert data["pressure"] == 1012.8
    assert data["light"] == 250
    assert data["accelerometer"] == [0.05, -0.02, 9.81]
    assert data["ok"] is True


def test_set_led_disconnected(client):
    """POST /v1/hardware/led returns ok=False when device is disconnected."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = False
    set_default_bridge(bridge)

    res = client.post("/v1/hardware/led", json={"r": 0, "g": 255, "b": 0, "pattern": "solid"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "not connected" in data["error"].lower()


def test_set_led_success(client):
    """POST /v1/hardware/led successfully forwards color and pattern to bridge."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = True

    # Intercept command and immediately ACK
    original_send = bridge.send_command

    async def mock_send(cmd, params=None, **kwargs):
        return {"id": "mock_cmd", "ok": True}

    bridge.send_command = mock_send
    set_default_bridge(bridge)

    res = client.post("/v1/hardware/led", json={"r": 255, "g": 128, "b": 0, "pattern": "breathe"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["error"] is None


def test_set_led_validation_errors(client):
    """POST /v1/hardware/led returns 422 for out-of-range RGB values."""
    res = client.post("/v1/hardware/led", json={"r": 300, "g": 0, "b": 0})
    assert res.status_code == 422

    res_negative = client.post("/v1/hardware/led", json={"r": -10, "g": 0, "b": 0})
    assert res_negative.status_code == 422
