"""Tests for the Workflows and Proactive Autonomy Engine."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
import pytest

from app.memory.service import MemoryService
from app.scheduler.runner import JobRunner, Scheduler
from app.tools.registry import ToolRegistry
from app.workflows.engine import WorkflowEngine
from app.workflows.steps import (
    ConditionStep,
    LlmStep,
    MemoryAddStep,
    NotifyStep,
    ToolStep,
    interpolate_variables,
)


def test_variable_interpolation_primitives_and_paths():
    data = {
        "user": {"name": "Alice", "id": "u42"},
        "step1": {"output": "ok", "count": 7},
        "raw_string": "hello world",
        "nested": {"deep": {"val": 123}},
    }
    # Exact match retains object type
    assert interpolate_variables("{{step1.count}}", data) == 7
    assert interpolate_variables("{{step1}}", data) == {"output": "ok", "count": 7}
    assert interpolate_variables("{{raw_string}}", data) == "hello world"
    assert interpolate_variables("{{nested.deep.val}}", data) == 123

    # Embedded string replacement
    assert (
        interpolate_variables("User {{user.name}} has {{step1.count}} items", data)
        == "User Alice has 7 items"
    )

    # Primitive with .output fallback
    prim_data = {"step1": "done"}
    assert interpolate_variables("{{step1.output}}", prim_data) == "done"

    # In dict and list
    nested_structure = {
        "msg": "Hello {{user.name}}",
        "items": ["{{step1.count}}", "constant"],
    }
    interpolated = interpolate_variables(nested_structure, data)
    assert interpolated == {"msg": "Hello Alice", "items": [7, "constant"]}


@pytest.mark.asyncio
async def test_sequential_workflow_execution(db):
    registry = ToolRegistry()

    def get_status(device_id: str) -> dict:
        return {"device_id": device_id, "status": "online", "battery": 88}

    registry.register(get_status, name="get_status")

    notifications_sent = []

    async def fake_notify(text: str) -> None:
        notifications_sent.append(text)

    engine = WorkflowEngine(
        registry=registry,
        db_conn=db,
        telegram_bot=fake_notify,
    )

    steps = [
        {
            "type": "tool",
            "tool_name": "get_status",
            "arguments": {"device_id": "dev-001"},
            "output_key": "step1",
        },
        {
            "type": "condition",
            "condition": "step1.status == 'online' and step1.battery > 50",
            "then": [
                {
                    "type": "notify",
                    "text": "Device {{step1.device_id}} is healthy at {{step1.battery}}% battery",
                    "output_key": "notif",
                }
            ],
            "else": [
                {
                    "type": "notify",
                    "text": "Device unhealthy",
                    "output_key": "notif",
                }
            ],
            "output_key": "cond_check",
        },
        {
            "type": "memory_add",
            "content": "Observed {{step1.device_id}} online with {{step1.battery}}% battery",
            "source": "workflow",
            "confidence": 0.85,
            "output_key": "mem_entry",
        },
    ]

    result = await engine.execute_workflow(steps)

    assert result["status"] == "completed"
    assert result["error"] is None
    assert result["outputs"]["step1"]["battery"] == 88
    assert result["outputs"]["cond_check"]["branch"] == "then"
    assert "mem_entry" in result["outputs"]
    mem_id = result["outputs"]["mem_entry"]["id"]
    assert mem_id is not None

    # Check notification dispatched
    assert notifications_sent == ["Device dev-001 is healthy at 88% battery"]
    assert len(result["notifications"]) == 1
    assert result["notifications"][0]["sent"] is True

    # Check memory recorded in DB
    mem_service = MemoryService(db)
    memory = mem_service.repo.get(mem_id)
    assert memory is not None
    assert memory.content == "Observed dev-001 online with 88% battery"
    assert memory.confidence == 0.85
    assert memory.source == "workflow"


@pytest.mark.asyncio
async def test_condition_branching_then_vs_else():
    engine = WorkflowEngine()

    then_steps = [
        {"type": "noop", "output_key": "branch_executed", "val": "then_branch"}
    ]
    else_steps = [
        {"type": "noop", "output_key": "branch_executed", "val": "else_branch"}
    ]

    # Test condition True -> takes then
    workflow_true = [
        {
            "type": "condition",
            "condition": "score >= 80",
            "then": then_steps,
            "else": else_steps,
            "output_key": "cond",
        }
    ]
    res_true = await engine.execute_workflow(workflow_true, context={"score": 95})
    assert res_true["status"] == "completed"
    assert res_true["outputs"]["cond"]["branch"] == "then"
    assert res_true["outputs"]["branch_executed"]["type"] == "noop"

    # Test condition False -> takes else
    res_false = await engine.execute_workflow(workflow_true, context={"score": 50})
    assert res_false["status"] == "completed"
    assert res_false["outputs"]["cond"]["branch"] == "else"


@pytest.mark.asyncio
async def test_failure_handling_halts_workflow_cleanly():
    registry = ToolRegistry()

    call_order = []

    def tool_ok():
        call_order.append("ok")
        return {"status": "ok"}

    def tool_failing():
        call_order.append("failing")
        raise ValueError("simulated tool failure")

    registry.register(tool_ok, name="tool_ok")
    registry.register(tool_failing, name="tool_failing")

    notifications = []

    async def notify(msg: str):
        notifications.append(msg)

    engine = WorkflowEngine(registry=registry, telegram_bot=notify)

    steps = [
        {"type": "tool", "tool_name": "tool_ok", "output_key": "step1"},
        {"type": "tool", "tool_name": "tool_failing", "output_key": "step2"},
        {"type": "notify", "text": "Should not be sent", "output_key": "step3"},
    ]

    result = await engine.execute_workflow(steps)

    assert result["status"] == "failed"
    assert "simulated tool failure" in result["error"]
    assert call_order == ["ok", "failing"]
    # Step 3 must never have run
    assert notifications == []
    assert "step1" in result["outputs"]
    assert "step2" not in result["outputs"]
    assert "step3" not in result["outputs"]


@pytest.mark.asyncio
async def test_llm_step_execution():
    class FakeProvider:
        async def generate_text(self, req):
            prompt_content = req.messages[-1].content
            return type("Resp", (), {"content": f"Summary of: {prompt_content}"})()

    engine = WorkflowEngine(provider=FakeProvider())

    steps = [
        {
            "type": "llm",
            "prompt": "Analyze topic: {{context.topic}}",
            "model": "test-model",
            "output_key": "summary",
        }
    ]

    res = await engine.execute_workflow(steps, context={"topic": "quantum"})
    assert res["status"] == "completed"
    assert res["outputs"]["summary"] == "Summary of: Analyze topic: quantum"


@pytest.mark.asyncio
async def test_timeout_handling():
    registry = ToolRegistry()

    async def slow_tool():
        await asyncio.sleep(0.5)
        return "slow"

    registry.register(slow_tool, name="slow_tool")

    engine = WorkflowEngine(registry=registry)
    steps = [{"type": "tool", "tool_name": "slow_tool"}]

    res = await engine.execute_workflow(steps, timeout=0.05)
    assert res["status"] == "failed"
    assert "timed out" in res["error"]


@pytest.mark.asyncio
async def test_scheduler_runner_executes_workflow_job_under_lease(db):
    registry = ToolRegistry()
    events = []

    def ping(msg: str) -> str:
        events.append(f"ping:{msg}")
        return f"pong:{msg}"

    registry.register(ping, name="ping")

    notifications = []

    async def notify(text: str) -> None:
        notifications.append(text)

    s = Scheduler(db)
    job = s.create_job(
        "proactive_check",
        "0 8 * * *",
        "Asia/Kolkata",
        {
            "steps": [
                {
                    "type": "tool",
                    "tool_name": "ping",
                    "arguments": {"msg": "sensor_01"},
                    "output_key": "step1",
                },
                {
                    "type": "notify",
                    "text": "Job output: {{step1}}",
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
        s,
        notify=notify,
        registry=registry,
    )

    completed = await runner.run_once(now=job.next_run)
    assert len(completed) == 1
    job_res = completed[0]
    assert job_res.id == job.id
    assert job_res.lease_owner is None
    assert job_res.next_run > job.next_run

    assert events == ["ping:sensor_01"]
    assert notifications == ["Job output: pong:sensor_01"]

    # Verify job_runs record
    run = db.execute("SELECT * FROM job_runs WHERE job_id = ?", (job.id,)).fetchone()
    assert run is not None
    assert run["status"] == "success"
    assert run["output"] is not None
    assert "pong:sensor_01" in run["output"]

    # Verify memory created
    mem_row = db.execute(
        "SELECT * FROM memories WHERE content LIKE '%Check completed: pong:sensor_01%'"
    ).fetchone()
    assert mem_row is not None
    assert mem_row["source"] == "workflow"
