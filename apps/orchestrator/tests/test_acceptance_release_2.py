"""Potaeto Release 2 Acceptance Scenarios.

Verifies the end-to-end integration requirements for Release 2:
1. "Research quantum computing and turn the LED green":
   Agent executes `lens_research`, invokes `arduino_led(0, 255, 0)`, and records audit events.
2. Memory governance evals suite:
   Validates all 7 formal memory lifecycle invariants.
3. Voice synthesis:
   Synthesizes audio to WAV file with deterministic SHA-256 disk caching.
4. Workflow engine:
   Leased workflow execution runs once, updates next_run, and audits run history.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
import wave

import pytest

from app.agent.loop import AgentLoop
from app.db.connection import connect_db, run_migrations
from app.db.repositories.tool_calls import ToolCallRepo
from app.hardware.arduino import ArduinoBridge
from app.memory.service import MemoryService
from app.providers.base import ChatMessage, ChatRequest, StreamEvent
from app.scheduler.runner import JobRunner, Scheduler
from app.tools.arduino import ArduinoTools, set_default_bridge
from app.tools.lens_mcp import (
    LensMcpClient,
    LensResearchTools,
    set_default_lens_client,
)
from app.tools.registry import ToolRegistry
from app.voice.tts import PiperTts
import tests.test_memory_evals as mem_evals


# ---------------------------------------------------------------------------
# Test Providers & Mocks for Scenario 1
# ---------------------------------------------------------------------------

class MockArduinoBridge(ArduinoBridge):
    """Connected mock Arduino bridge that tracks commands without hardware."""

    def __init__(self) -> None:
        super().__init__(port="/dev/null")
        self.connected = True
        self.sent_commands: list[dict[str, Any]] = []

    async def send_command(
        self,
        cmd: str,
        params: dict[str, Any] | None = None,
        *,
        cmd_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        cid = cmd_id or f"cmd_mock_{len(self.sent_commands) + 1}"
        payload_params = dict(params or {})
        if cmd == "led":
            payload_params = self.map_led_payload(payload_params)
        payload = {"id": cid, "v": 1, "cmd": cmd, **payload_params}
        self.sent_commands.append(payload)
        self.last_sent_payload = payload
        return {"id": cid, "ok": True}


class MockLensClient:
    """Mock Lens MCP client that returns academic search results."""

    def __init__(self) -> None:
        self.searches: list[dict[str, Any]] = []

    async def search_literature(
        self, query: str, limit: int = 5
    ) -> dict[str, Any]:
        self.searches.append({"query": query, "limit": limit})
        return {
            "papers": [
                {
                    "title": "Quantum Computational Supremacy in Superconducting Processors",
                    "doi": "10.1038/s41586-019-1666-5",
                    "authors": ["Arute, F.", "Arya, K."],
                    "year": 2019,
                }
            ],
            "count": 1,
            "query": query,
        }


class ResearchAndLedProvider:
    """Simulates LLM executing:

    Turn 1 -> lens_research(query="quantum computing")
    Turn 2 -> arduino_led(r=0, g=255, b=0)
    Turn 3 -> Final answer.
    """

    name = "research-and-led-provider"

    def __init__(self) -> None:
        self.turn = 0

    async def stream_chat(self, request: ChatRequest):
        tool_messages = [m for m in request.messages if m.role == "tool"]
        num_tool_results = len(tool_messages)

        if num_tool_results == 0:
            # Step 1: Research quantum computing
            yield StreamEvent.tool_call_delta(
                index=0,
                id="call_lens_1",
                name="lens_research",
                args='{"query": "quantum computing"}',
            )
            yield StreamEvent.done("tool_calls")
        elif num_tool_results == 1:
            # Step 2: Turn the LED green
            yield StreamEvent.tool_call_delta(
                index=0,
                id="call_arduino_1",
                name="arduino_led",
                args='{"r": 0, "g": 255, "b": 0}',
            )
            yield StreamEvent.done("tool_calls")
        else:
            # Step 3: Conclude
            yield StreamEvent.token(
                "Researched quantum computing (1 paper found) and turned the status LED green."
            )
            yield StreamEvent.done("stop")


# ---------------------------------------------------------------------------
# Scenario 1: Research X and turn the LED green
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_acceptance_scenario_1_research_and_led(db):
    """Scenario 1: 'Research quantum computing and turn the LED green'.

    The agent loop invokes `lens_research`, invokes `arduino_led(0, 255, 0)`,
    and persists audit records in the SQLite `tool_calls` table.
    """
    mock_bridge = MockArduinoBridge()
    set_default_bridge(mock_bridge)

    mock_lens = MockLensClient()
    set_default_lens_client(mock_lens)

    provider = ResearchAndLedProvider()

    # Create AgentLoop with default tools (which now includes Lens and Arduino)
    loop = AgentLoop(db, provider, model="test-acceptance-model")
    conv_id = loop.ensure_conversation("u_local", "e_potaeto")

    events = [
        event
        async for event in loop.run(
            conv_id, "Research quantum computing and turn the LED green"
        )
    ]

    event_types = [e.type for e in events]
    assert "tool_call" in event_types
    assert "tool_result" in event_types
    assert "token" in event_types
    assert "done" in event_types

    # 1. Verify Lens MCP research executed
    assert len(mock_lens.searches) == 1
    assert mock_lens.searches[0]["query"] == "quantum computing"

    # 2. Verify Arduino LED command executed with green color (r=0, g=255, b=0)
    assert len(mock_bridge.sent_commands) == 1
    led_cmd = mock_bridge.sent_commands[0]
    assert led_cmd["cmd"] == "led"
    # Hardware inversion: 0 (off) -> 255; 255 (full bright) -> 0
    assert led_cmd["r"] == 255  # Red off
    assert led_cmd["g"] == 0    # Green full on
    assert led_cmd["b"] == 255  # Blue off

    # 3. Verify SQLite audit trail in tool_calls table
    tool_repo = ToolCallRepo(db)
    recorded_calls = tool_repo.list()
    assert len(recorded_calls) >= 2

    lens_calls = [c for c in recorded_calls if c.name == "lens_research"]
    assert len(lens_calls) == 1
    assert lens_calls[0].status == "succeeded"
    assert lens_calls[0].arguments_json == {"query": "quantum computing"}
    assert "papers" in lens_calls[0].result_json

    arduino_calls = [c for c in recorded_calls if c.name == "arduino_led"]
    assert len(arduino_calls) == 1
    assert arduino_calls[0].status == "succeeded"
    assert arduino_calls[0].arguments_json == {"r": 0, "g": 255, "b": 0}
    assert arduino_calls[0].result_json == {"ok": True, "id": mock_bridge.sent_commands[0]["id"]}


# ---------------------------------------------------------------------------
# Scenario 2: Memory Evals Suite Check (7 Formal Scenarios)
# ---------------------------------------------------------------------------

def test_acceptance_scenario_2_memory_governance_evals_suite(tmp_path: Path):
    """Scenario 2: Execute all 7 formal memory lifecycle scenarios."""
    def fresh_conn(name: str):
        conn = connect_db(tmp_path / f"{name}.db")
        run_migrations(conn)
        return conn

    # 1. Restart recall
    c1 = fresh_conn("eval1")
    try:
        mem_evals.test_eval_1_restart_recall(tmp_path, c1)
    finally:
        c1.close()

    # 2. Multi-session recall
    c2 = fresh_conn("eval2")
    try:
        mem_evals.test_eval_2_multi_session_recall(c2)
    finally:
        c2.close()

    # 3. Update/supersede wins
    c3 = fresh_conn("eval3")
    try:
        mem_evals.test_eval_3_update_wins(c3)
    finally:
        c3.close()

    # 4. Stale fact outside temporal validity
    c4 = fresh_conn("eval4")
    try:
        mem_evals.test_eval_4_stale_not_current(c4)
    finally:
        c4.close()

    # 5. Retraction
    c5 = fresh_conn("eval5")
    try:
        mem_evals.test_eval_5_retraction(c5)
    finally:
        c5.close()

    # 6. Remembered-preference action
    c6 = fresh_conn("eval6")
    try:
        mem_evals.test_eval_6_remembered_preference_action(c6)
    finally:
        c6.close()

    # 7. Scope isolation
    c7 = fresh_conn("eval7")
    try:
        mem_evals.test_eval_7_scope_isolation(c7)
    finally:
        c7.close()


# ---------------------------------------------------------------------------
# Scenario 3: Voice synthesize -> WAV file returned and cached
# ---------------------------------------------------------------------------

def test_acceptance_scenario_3_voice_synthesize_and_caching(tmp_path: Path):
    """Scenario 3: Voice synthesize creates valid WAV and caches via SHA-256."""
    cache_dir = tmp_path / "voice_cache"
    tts = PiperTts(cache_dir=str(cache_dir), model_path="models/dummy.onnx")

    text = "Hello Potaeto voice test"
    voice = "en_US-lessac-medium"

    # 1. Synthesize generates valid WAV
    wav_path = tts.synthesize(text, voice=voice)
    assert Path(wav_path).exists()
    assert Path(wav_path).stat().st_size > 0

    with wave.open(wav_path, "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getframerate() == 16000

    expected_hash = tts.compute_cache_key(text, voice)
    assert Path(wav_path).name == f"{expected_hash}.wav"

    # 2. Subsequent call hits cache without regenerating
    mtime_before = Path(wav_path).stat().st_mtime_ns
    cached_path = tts.synthesize(text, voice=voice)
    assert cached_path == wav_path
    assert Path(cached_path).stat().st_mtime_ns == mtime_before


# ---------------------------------------------------------------------------
# Scenario 4: Workflow leased execution runs once and completes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_acceptance_scenario_4_workflow_leased_execution(db):
    """Scenario 4: Workflow leased execution runs once and completes."""
    registry = ToolRegistry()
    execution_trace: list[str] = []

    def mock_sensor(param: str) -> str:
        execution_trace.append(f"sensor:{param}")
        return f"sensor_val_{param}"

    registry.register(mock_sensor, name="mock_sensor")

    notifications: list[str] = []

    async def mock_notify(text: str) -> None:
        notifications.append(text)

    scheduler = Scheduler(db)

    # Register workflow job with tool, notification, and memory steps
    job = scheduler.create_job(
        "proactive_sensor_check",
        "0 8 * * *",
        "Asia/Kolkata",
        {
            "steps": [
                {
                    "type": "tool",
                    "tool_name": "mock_sensor",
                    "arguments": {"param": "telemetry"},
                    "output_key": "step1",
                },
                {
                    "type": "notify",
                    "text": "Sensor reading: {{step1}}",
                    "output_key": "step2",
                },
                {
                    "type": "memory_add",
                    "content": "Check completed: {{step1}}",
                    "source": "workflow",
                    "output_key": "mem",
                },
            ]
        },
    )

    runner = JobRunner(
        scheduler,
        notify=mock_notify,
        registry=registry,
    )

    # Run once at scheduled time
    completed = await runner.run_once(now=job.next_run)
    assert len(completed) == 1
    res = completed[0]
    assert res.id == job.id
    assert res.lease_owner is None
    assert res.next_run > job.next_run

    # Verify execution effects
    assert execution_trace == ["sensor:telemetry"]
    assert notifications == ["Sensor reading: sensor_val_telemetry"]

    # Verify run logged in job_runs table
    run_record = db.execute(
        "SELECT status, output FROM job_runs WHERE job_id = ?", (job.id,)
    ).fetchone()
    assert run_record is not None
    assert run_record["status"] == "success"

    # Verify executing again does not re-run (job is not due yet)
    re_completed = await runner.run_once(now=job.next_run)
    assert len(re_completed) == 0
    assert len(execution_trace) == 1
