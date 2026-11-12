"""Tests for Arduino Serial Bridge, Protocol v1, and Hardware Tools."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time

import pytest

from app.hardware.arduino import ArduinoBridge
from app.tools.arduino import (
    ArduinoTools,
    arduino_led,
    arduino_pattern,
    arduino_read,
    set_default_bridge,
)


@pytest.mark.asyncio
async def test_arduino_bridge_command_and_ack(monkeypatch):
    """Test sending a command with pre-configured mock ACK response."""
    bridge = ArduinoBridge(port="/dev/null")
    # Simulate connection ack
    bridge.connected = True
    bridge._mock_responses["cmd_1"] = {"id": "cmd_1", "ok": True}

    res = await bridge.send_command(
        "led", {"r": 0, "g": 255, "b": 0, "pattern": "solid"}, cmd_id="cmd_1"
    )
    assert res["ok"] is True
    assert res["id"] == "cmd_1"
    assert bridge.is_connected is True


@pytest.mark.asyncio
async def test_command_formatting_and_ack_resolution():
    """Verify Protocol v1 payload structure and asynchronous line ACK resolution."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = True

    async def simulate_incoming_ack(cmd_id: str):
        await asyncio.sleep(0.01)
        bridge.handle_line(json.dumps({"id": cmd_id, "ok": True, "result": "acknowledged"}))

    task = asyncio.create_task(simulate_incoming_ack("cmd_test_42"))
    res = await bridge.send_command("ping", {"foo": "bar"}, cmd_id="cmd_test_42", timeout=1.0)
    await task

    assert res["ok"] is True
    assert res["id"] == "cmd_test_42"
    assert res["result"] == "acknowledged"

    # Verify formatted payload sent to device
    assert bridge.last_sent_payload == {
        "id": "cmd_test_42",
        "v": 1,
        "cmd": "ping",
        "foo": "bar",
    }


@pytest.mark.asyncio
async def test_timeout_handling_when_no_ack_received():
    """Bridge must timeout gracefully and return structured error if no ACK arrives."""
    bridge = ArduinoBridge(port="/dev/null", timeout=0.05)
    bridge.connected = True

    res = await bridge.send_command("led", {"r": 100, "g": 100, "b": 100}, timeout=0.05)
    assert res["ok"] is False
    assert "timed out" in res["error"].lower()
    # Ensure pending future was cleaned up
    assert len(bridge._pending_commands) == 0


def test_active_low_led_mapping():
    """Verify active-low inversion: software 255 (full) -> hardware 0, software 0 -> hardware 255."""
    assert ArduinoBridge.map_led_value(255) == 0
    assert ArduinoBridge.map_led_value(0) == 255
    assert ArduinoBridge.map_led_value(128) == 127
    assert ArduinoBridge.map_led_value(None) == 255

    # Clamping behavior
    assert ArduinoBridge.map_led_value(300) == 0
    assert ArduinoBridge.map_led_value(-50) == 255


@pytest.mark.asyncio
async def test_active_low_led_wire_payload():
    """Verify that send_command transparently inverts LED values on the wire."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = True
    bridge._mock_responses["cmd_led"] = {"id": "cmd_led", "ok": True}

    await bridge.send_command(
        "led",
        {"r": 255, "g": 0, "b": 64, "pattern": "breathe"},
        cmd_id="cmd_led",
    )

    sent = bridge.last_sent_payload
    assert sent is not None
    assert sent["v"] == 1
    assert sent["cmd"] == "led"
    # 255 -> 0, 0 -> 255, 64 -> 191
    assert sent["r"] == 0
    assert sent["g"] == 255
    assert sent["b"] == 191
    assert sent["pattern"] == "breathe"


def test_telemetry_event_ingestion_and_caching(db: sqlite3.Connection):
    """Telemetry line updates latest cache and records into serial_events database table."""
    bridge = ArduinoBridge(port="/dev/null", db=db)
    bridge.connected = True

    telemetry_line = json.dumps({
        "evt": "telemetry",
        "temp": 24.5,
        "hum": 50.2,
        "press": 1013.25,
        "light": 120,
        "acc": [0.0, 0.0, 9.8],
    })
    bridge.handle_line(telemetry_line)

    # Verify latest telemetry cache
    assert bridge.latest_telemetry["temp"] == 24.5
    assert bridge.latest_telemetry["hum"] == 50.2
    assert bridge.latest_telemetry["press"] == 1013.25
    assert bridge.latest_telemetry["light"] == 120
    assert bridge.latest_telemetry["acc"] == [0.0, 0.0, 9.8]

    # Verify database persistence
    rows = db.execute("SELECT event_type, payload_json FROM serial_events").fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "telemetry"
    saved = json.loads(rows[0][1])
    assert saved["temp"] == 24.5
    assert saved["hum"] == 50.2


def test_serial_events_pruning_older_than_7_days(db: sqlite3.Connection):
    """Pruning deletes records older than 7 days while preserving recent records."""
    bridge = ArduinoBridge(port="/dev/null", db=db)

    now = time.time()
    old_time = now - (8 * 86400)  # 8 days ago
    recent_time = now - (2 * 86400)  # 2 days ago

    db.execute(
        "INSERT INTO serial_events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
        ("telemetry", '{"old": true}', old_time),
    )
    db.execute(
        "INSERT INTO serial_events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
        ("telemetry", '{"recent": true}', recent_time),
    )
    db.commit()

    # Prune with 7 day retention (default)
    deleted = bridge.prune_events(retention_seconds=7 * 86400)
    assert deleted == 1

    remaining = db.execute("SELECT payload_json FROM serial_events").fetchall()
    assert len(remaining) == 1
    assert json.loads(remaining[0][0]) == {"recent": True}


@pytest.mark.asyncio
async def test_graceful_behavior_when_serial_unavailable():
    """Bridge and tools must gracefully return error dicts without crashing or hanging."""
    bridge = ArduinoBridge(port="/dev/nonexistent-potaeto-serial")

    # Connect fails gracefully
    connected = await bridge.connect()
    assert connected is False
    assert bridge.is_connected is False

    # Bridge send_command returns error dict
    res = await bridge.send_command("led", {"r": 255, "g": 0, "b": 0})
    assert res["ok"] is False
    assert "not connected" in res["error"].lower()

    # Tool calls degrade gracefully
    led_res = await arduino_led(255, 0, 0, bridge=bridge)
    assert led_res["ok"] is False
    assert "not connected" in led_res["error"].lower()

    read_res = arduino_read(bridge=bridge)
    assert read_res["ok"] is False
    assert "not connected" in read_res["error"].lower()

    pattern_res = await arduino_pattern("alert", bridge=bridge)
    assert pattern_res["ok"] is False
    assert "not connected" in pattern_res["error"].lower()


@pytest.mark.asyncio
async def test_arduino_tools_led_read_and_pattern():
    """Test high-level tools: arduino_led, arduino_read, and preset patterns."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = True
    set_default_bridge(bridge)

    # Ingest telemetry
    bridge.handle_line(json.dumps({
        "evt": "telemetry",
        "temp": 22.8,
        "hum": 45.0,
        "press": 1015.0,
        "light": 300,
        "acc": [0.1, -0.1, 9.81],
    }))

    # arduino_read synchronous / awaitable usage
    readings = arduino_read(bridge=bridge)
    assert readings["ok"] is True
    assert readings["temperature"] == 22.8
    assert readings["humidity"] == 45.0
    assert readings["pressure"] == 1015.0
    assert readings["light"] == 300
    assert readings["accelerometer"] == [0.1, -0.1, 9.81]

    readings_async = await arduino_read(bridge=bridge)
    assert readings_async["temperature"] == 22.8

    # Preset patterns
    bridge._mock_responses.clear()
    # Mock any command id
    async def auto_ack_loop():
        while True:
            for cid in list(bridge._pending_commands.keys()):
                bridge.handle_line(json.dumps({"id": cid, "ok": True}))
            await asyncio.sleep(0.005)

    ack_task = asyncio.create_task(auto_ack_loop())

    try:
        # Test alert pattern
        alert_res = await arduino_pattern("alert", bridge=bridge)
        assert alert_res["ok"] is True
        assert alert_res.get("preset") == "alert"
        # Alert is red blink (software: 255, 0, 0 -> wire: 0, 255, 255)
        assert bridge.last_sent_payload["r"] == 0
        assert bridge.last_sent_payload["g"] == 255
        assert bridge.last_sent_payload["b"] == 255
        assert bridge.last_sent_payload["pattern"] == "blink"

        # Test thinking pattern
        thinking_res = await arduino_pattern("thinking", bridge=bridge)
        assert thinking_res["ok"] is True
        assert thinking_res.get("preset") == "thinking"
        assert bridge.last_sent_payload["pattern"] == "breathe"

        # Test success pattern
        success_res = await arduino_pattern("success", bridge=bridge)
        assert success_res["ok"] is True
        assert success_res.get("preset") == "success"

        # Test unknown pattern
        unknown_res = await arduino_pattern("party_disco", bridge=bridge)
        assert unknown_res["ok"] is False
        assert "unknown preset pattern" in unknown_res["error"].lower()

        # Test ArduinoTools class wrapper
        tools = ArduinoTools(bridge)
        tool_map = tools.as_tool_map()
        assert "arduino_led" in tool_map
        assert "arduino_read" in tool_map
        assert "arduino_pattern" in tool_map

        read_tool_res = tool_map["arduino_read"]()
        assert read_tool_res["temperature"] == 22.8
    finally:
        ack_task.cancel()
        set_default_bridge(None)


def test_malformed_serial_lines_do_not_crash():
    """Corrupt, incomplete, or non-JSON serial lines must be ignored safely."""
    bridge = ArduinoBridge(port="/dev/null")
    bridge.connected = True

    # None of these should raise
    bridge.handle_line("")
    bridge.handle_line("    ")
    bridge.handle_line("{incomplete json")
    bridge.handle_line("null")
    bridge.handle_line("[1, 2, 3]")
    bridge.handle_line("random garbage string \x00\xff")
    assert bridge.latest_telemetry == {}
