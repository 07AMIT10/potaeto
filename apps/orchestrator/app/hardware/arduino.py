"""Arduino Nano 33 BLE Sense Rev2 serial bridge and Protocol v1 handler.

Manages the serial connection lifecycle to `/dev/potaeto-arduino` at 115200 baud,
handles command dispatch with unique IDs, correlates ACKs via asyncio Futures,
ingests telemetry into SQLite, transparently maps active-low RGB LEDs,
and degrades gracefully when hardware is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
import uuid
from contextlib import suppress
from typing import Any

from app.db.connection import WRITE_LOCK

logger = logging.getLogger(__name__)

DEFAULT_PORT = "/dev/potaeto-arduino"
DEFAULT_BAUDRATE = 115200
DEFAULT_TIMEOUT_SEC = 3.0
RETENTION_SECONDS_7_DAYS = 7 * 86400.0


class ArduinoBridge:
    """Async serial bridge to Arduino Nano 33 BLE Sense Rev2."""

    def __init__(
        self,
        port: str = DEFAULT_PORT,
        baudrate: int = DEFAULT_BAUDRATE,
        timeout: float = DEFAULT_TIMEOUT_SEC,
        db: sqlite3.Connection | None = None,
        retention_seconds: float = RETENTION_SECONDS_7_DAYS,
    ) -> None:
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.db = db
        self.retention_seconds = retention_seconds

        self._connected: bool = False
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task[None] | None = None
        self._pending_commands: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._latest_telemetry: dict[str, Any] = {}
        self._mock_responses: dict[str, dict[str, Any]] = {}
        self._last_prune_time: float = 0.0

        # Debug/inspection hooks for tests and observability
        self.last_sent_payload: dict[str, Any] | None = None
        self.last_wire_message: str | None = None

    @property
    def is_connected(self) -> bool:
        """Whether the serial connection is currently open and active."""
        return self._connected

    @property
    def connected(self) -> bool:
        """Alias for is_connected (read/write for mock testing)."""
        return self._connected

    @connected.setter
    def connected(self, value: bool) -> None:
        self._connected = bool(value)

    @is_connected.setter
    def is_connected(self, value: bool) -> None:
        self._connected = bool(value)

    @property
    def latest_telemetry(self) -> dict[str, Any]:
        """Return a copy of the latest sensor telemetry readings."""
        return dict(self._latest_telemetry)

    # -- Active-low RGB LED mapping --------------------------------------

    @staticmethod
    def map_led_value(val: float | None) -> int:
        """Invert 0..255 brightness for active-low hardware LEDs.

        On Arduino Nano 33 BLE Sense Rev2:
        - 0: Full brightness (active-low driven to GND).
        - 255: Off (driven to VCC).
        Software callers provide standard 0 (off) .. 255 (full bright).
        """
        if val is None:
            return 255
        try:
            clamped = max(0, min(255, int(val)))
        except (ValueError, TypeError):
            clamped = 0
        return 255 - clamped

    @classmethod
    def map_led_payload(cls, params: dict[str, Any]) -> dict[str, Any]:
        """Map RGB parameters from software brightness (0=off) to active-low hardware values."""
        mapped = dict(params)
        for key in ("r", "g", "b"):
            if key in mapped:
                mapped[key] = cls.map_led_value(mapped[key])
        if "pattern" not in mapped:
            mapped["pattern"] = "solid"
        return mapped

    # -- Serial Lifecycle ------------------------------------------------

    async def connect(self) -> bool:
        """Attempt to open the serial port non-blockingly.

        Returns True on success, or False if the device is unavailable.
        Never raises exceptions to ensure graceful degradation.
        """
        if self._connected:
            return True

        try:
            import serial_asyncio

            reader, writer = await serial_asyncio.open_serial_connection(
                url=self.port, baudrate=self.baudrate
            )
            self._reader = reader
            self._writer = writer
            self._connected = True
            self._read_task = asyncio.create_task(
                self._reader_loop(), name=f"arduino-reader-{self.port}"
            )
            logger.info("Connected to Arduino on %s (%d baud)", self.port, self.baudrate)
            return True
        except Exception as exc:  # noqa: BLE001 - graceful degradation on missing hardware
            logger.warning(
                "Could not connect to Arduino serial on %s: %s (will degrade gracefully)",
                self.port,
                exc,
            )
            self._connected = False
            return False

    async def disconnect(self) -> None:
        """Safely close the serial connection and cancel reader loops."""
        self._connected = False
        if self._read_task is not None and not self._read_task.done():
            self._read_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._read_task
            self._read_task = None

        if self._writer is not None:
            with suppress(Exception):
                self._writer.close()
                await self._writer.wait_closed()
            self._writer = None
        self._reader = None

        # Cancel any pending command futures
        for cid, fut in list(self._pending_commands.items()):
            if not fut.done():
                fut.cancel()
        self._pending_commands.clear()

    async def _reader_loop(self) -> None:
        """Background coroutine continuously reading newline-terminated JSON."""
        try:
            while self._connected and self._reader is not None:
                line_bytes = await self._reader.readline()
                if not line_bytes:
                    logger.info("Arduino serial port reached EOF on %s", self.port)
                    break
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if line:
                    self.handle_line(line)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - serial reader loop failure
            logger.warning("Error in Arduino serial reader loop: %s", exc)
        finally:
            self._connected = False

    # -- Protocol v1 Message Handling ------------------------------------

    def handle_line(self, line: str) -> None:
        """Parse one incoming line and dispatch to ACK future or telemetry cache."""
        line = line.strip()
        if not line:
            return

        try:
            msg = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            logger.debug("Ignored unparseable serial line: %r", line)
            return

        if not isinstance(msg, dict):
            return

        # 1. Correlate command ACK by ID
        cid = msg.get("id")
        if cid and cid in self._pending_commands:
            fut = self._pending_commands[cid]
            if not fut.done():
                fut.set_result(msg)

        # 2. Telemetry ingestion
        if msg.get("evt") == "telemetry" or ("temp" in msg and "hum" in msg):
            self._latest_telemetry = msg
            evt_type = msg.get("evt", "telemetry")
            self.record_event(evt_type, msg)
            self.prune_events_if_needed()

    # -- Command Dispatch ------------------------------------------------

    async def send_command(
        self,
        cmd: str,
        params: dict[str, Any] | None = None,
        *,
        cmd_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send a Protocol v1 JSON command and await its correlated ACK."""
        if not self.is_connected:
            return {"ok": False, "error": "Arduino not connected"}

        cid = cmd_id or f"cmd_{uuid.uuid4().hex[:8]}"
        payload_params = dict(params or {})

        # Active-low LED mapping:
        # Software passes 0 (off) .. 255 (full bright);
        # Hardware expects inverted values.
        if cmd == "led":
            payload_params = self.map_led_payload(payload_params)

        payload: dict[str, Any] = {
            "id": cid,
            "v": 1,
            "cmd": cmd,
            **payload_params,
        }
        self.last_sent_payload = payload
        wire_str = json.dumps(payload, separators=(",", ":")) + "\n"
        self.last_wire_message = wire_str

        # If a mock response is pre-configured (testing aid)
        if cid in self._mock_responses:
            return self._mock_responses[cid]

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending_commands[cid] = fut

        if self._writer is not None:
            try:
                self._writer.write(wire_str.encode("utf-8"))
                await self._writer.drain()
            except Exception as exc:  # noqa: BLE001 - serial write error
                self._pending_commands.pop(cid, None)
                self._connected = False
                logger.warning("Failed to write to Arduino serial: %s", exc)
                return {"ok": False, "error": f"Failed to write to serial: {exc}"}

        eff_timeout = timeout if timeout is not None else self.timeout
        try:
            return await asyncio.wait_for(fut, timeout=eff_timeout)
        except TimeoutError:
            return {"ok": False, "error": f"Command {cid} timed out after {eff_timeout}s"}
        finally:
            self._pending_commands.pop(cid, None)

    async def set_led(
        self,
        r: int,
        g: int,
        b: int,
        pattern: str = "solid",
        *,
        cmd_id: str | None = None,
    ) -> dict[str, Any]:
        """Convenience method to dispatch LED command."""
        return await self.send_command(
            "led",
            {"r": r, "g": g, "b": b, "pattern": pattern},
            cmd_id=cmd_id,
        )

    # -- Telemetry Storage & Retention -----------------------------------

    def record_event(self, event_type: str, payload: dict[str, Any]) -> None:
        """Persist a serial event or telemetry reading to the database."""
        if self.db is None:
            return

        now = time.time()
        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        try:
            with WRITE_LOCK:
                self.db.execute(
                    "INSERT INTO serial_events (event_type, payload_json, created_at) "
                    "VALUES (?, ?, ?)",
                    (event_type, payload_json, now),
                )
                self.db.commit()
        except Exception as exc:  # noqa: BLE001 - telemetry DB write
            logger.warning("Failed to record serial event: %s", exc)

    def prune_events(self, retention_seconds: float | None = None) -> int:
        """Prune serial events older than retention_seconds (default 7 days)."""
        if self.db is None:
            return 0

        retention = (
            retention_seconds
            if retention_seconds is not None
            else self.retention_seconds
        )
        cutoff = time.time() - retention
        try:
            with WRITE_LOCK:
                cur = self.db.execute(
                    "DELETE FROM serial_events WHERE created_at < ?",
                    (cutoff,),
                )
                self.db.commit()
                return cur.rowcount
        except Exception as exc:  # noqa: BLE001 - serial event pruning
            logger.warning("Failed to prune serial events: %s", exc)
            return 0

    def prune_events_if_needed(self, interval_seconds: float = 3600.0) -> None:
        """Trigger pruning periodically (default every 1 hour) upon event ingestion."""
        now = time.time()
        if now - self._last_prune_time >= interval_seconds:
            self._last_prune_time = now
            self.prune_events()
