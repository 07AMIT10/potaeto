"""Workflow engine for the Proactive Autonomy Engine.

Executes sequential step lists with variable propagation, branching,
error isolation, timeouts, and notification/audit tracking.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from typing import Any

from app.tools.registry import ToolRegistry
from app.workflows.steps import WorkflowStep, parse_step

logger = logging.getLogger(__name__)


class WorkflowEngine:
    """Execute composable step workflows sequentially under durable governance."""

    def __init__(
        self,
        registry: ToolRegistry | None = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
    ) -> None:
        self.registry = registry if registry is not None else ToolRegistry()
        self.db_conn = db_conn
        self.provider = provider
        self.telegram_bot = telegram_bot

    async def execute_workflow(
        self,
        steps: list[dict[str, Any] | WorkflowStep],
        context: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Execute a list of steps sequentially.

        Returns:
            dict containing:
                - status: "completed" | "failed"
                - outputs: dictionary of step results keyed by output_key
                - notifications: list of notifications dispatched
                - tool_executions: list of tools invoked
                - audit_events: list of audit events emitted
                - error: error message string or None
                - steps: list of step execution summaries
        """
        if not isinstance(steps, list):
            return {
                "status": "failed",
                "outputs": {},
                "notifications": [],
                "tool_executions": [],
                "audit_events": [],
                "steps": [],
                "error": "'steps' must be a list",
            }

        if timeout is not None and timeout > 0:
            try:
                async with asyncio.timeout(timeout):
                    return await self._run_steps(steps, context)
            except TimeoutError:
                return {
                    "status": "failed",
                    "outputs": {},
                    "notifications": [],
                    "tool_executions": [],
                    "audit_events": [],
                    "steps": [],
                    "error": f"workflow timed out after {timeout}s",
                }
            except asyncio.CancelledError:
                return {
                    "status": "failed",
                    "outputs": {},
                    "notifications": [],
                    "tool_executions": [],
                    "audit_events": [],
                    "steps": [],
                    "error": "workflow was cancelled",
                }
        else:
            return await self._run_steps(steps, context)

    async def _run_steps(
        self,
        steps: list[dict[str, Any] | WorkflowStep],
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ctx = dict(context or {})
        outputs: dict[str, Any] = {}
        notifications: list[dict[str, Any]] = []
        tool_executions: list[dict[str, Any]] = []
        audit_events: list[dict[str, Any]] = []
        executed_steps: list[dict[str, Any]] = []

        for index, raw_step in enumerate(steps):
            if not isinstance(raw_step, (dict, WorkflowStep)):
                return {
                    "status": "failed",
                    "outputs": outputs,
                    "notifications": notifications,
                    "tool_executions": tool_executions,
                    "audit_events": audit_events,
                    "steps": executed_steps,
                    "error": f"step {index} is not an object",
                }

            try:
                step_obj = parse_step(raw_step)
            except Exception as exc:
                return {
                    "status": "failed",
                    "outputs": outputs,
                    "notifications": notifications,
                    "tool_executions": tool_executions,
                    "audit_events": audit_events,
                    "steps": executed_steps,
                    "error": f"step {index}: {exc}",
                }

            try:
                result = await step_obj.execute(
                    context=ctx,
                    outputs=outputs,
                    registry=self.registry,
                    db_conn=self.db_conn,
                    provider=self.provider,
                    telegram_bot=self.telegram_bot,
                    notifications=notifications,
                    tool_executions=tool_executions,
                    audit_events=audit_events,
                    engine=self,
                )
            except Exception as exc:
                logger.error("Step %d (%s) failed: %s", index, step_obj.type, exc)
                return {
                    "status": "failed",
                    "outputs": outputs,
                    "notifications": notifications,
                    "tool_executions": tool_executions,
                    "audit_events": audit_events,
                    "steps": executed_steps,
                    "error": f"step {index}: {exc}",
                }

            out_key = getattr(step_obj, "output_key", None)
            if out_key:
                outputs[out_key] = result
            step_id = getattr(step_obj, "id", None)
            if step_id and step_id not in outputs:
                outputs[step_id] = result
            default_key = f"step_{index}"
            if default_key not in outputs:
                outputs[default_key] = result

            summary = {"type": step_obj.type}
            if isinstance(raw_step, dict):
                summary.update({k: v for k, v in raw_step.items() if k != "type"})
            executed_steps.append(summary)

        return {
            "status": "completed",
            "outputs": outputs,
            "notifications": notifications,
            "tool_executions": tool_executions,
            "audit_events": audit_events,
            "steps": executed_steps,
            "error": None,
        }
