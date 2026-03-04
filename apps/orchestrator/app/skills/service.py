"""
SkillsService: load skill + pipeline_config from DB and execute steps.
Pipeline config DSL (JSON):
  steps: [ { id, type: "llm"|"postprocess", task_type?, prompt_template_id?, kind? } ]
  inputs: optional list of input names (request fields: prompt, entity_name, persona)
  outputs: optional list of output names (last step produces final output)
"""
from __future__ import annotations

from typing import Any, cast

from supabase import create_client

from app.config import get_settings
from app.router.model_router import ModelRouter, TaskType
from app.providers.base import TextMessage
from app.skills.prompts import get_system_prompt


def _build_context(entity_name: str | None, persona: dict[str, Any] | None) -> str:
    parts = []
    if entity_name:
        parts.append(f'The output is for the persona "{entity_name}".')
    if persona:
        parts.append(f"Persona details (JSON): {persona}")
    return "\n".join(parts) if parts else ""


async def _execute_llm_step(
    step: dict[str, Any],
    context: dict[str, Any],
    router: ModelRouter,
) -> str:
    task_type = step.get("task_type") or "skill_text"
    template_id = step.get("prompt_template_id")
    system_content = get_system_prompt(template_id)
    suffix = _build_context(
        context.get("entity_name"),
        context.get("persona"),
    )
    if suffix:
        system_content = f"{system_content}\n\n{suffix}"

    messages = [
        TextMessage(role="system", content=system_content),
        TextMessage(role="user", content=context.get("prompt", "")),
    ]
    response = await router.generate_text(
        task_type=cast(TaskType, task_type),
        messages=messages,
    )
    return (response.content or "").strip()


async def _execute_postprocess_step(step: dict[str, Any], input_text: str) -> str:
    kind = step.get("kind") or "trim"
    if kind == "trim":
        return input_text.strip()
    return input_text


async def run_pipeline(
    pipeline_config: dict[str, Any],
    context: dict[str, Any],
    router: ModelRouter,
) -> str:
    """
    Execute pipeline steps sequentially. Context must include prompt, and optionally entity_name, persona.
    Returns the final text output.
    """
    steps = pipeline_config.get("steps") or []
    if not steps:
        return ""

    current: str = ""
    for step in steps:
        step_type = step.get("type") or "llm"
        step_id = step.get("id") or ""

        if step_type == "llm":
            # First LLM step uses request context; later steps could use previous output as prompt
            if not current:
                ctx = dict(context)
            else:
                ctx = {**context, "prompt": current}
            current = await _execute_llm_step(step, ctx, router)
        elif step_type == "postprocess":
            current = await _execute_postprocess_step(step, current)
        else:
            continue

    return current


class SkillsService:
    """Load skill from DB and run pipeline_config. Falls back to None if no config."""

    def __init__(self, router: ModelRouter) -> None:
        settings = get_settings()
        self._client = create_client(settings.supabase.url, settings.supabase.anon_key)
        self._router = router

    def get_skill_config(self, skill_id: str) -> dict[str, Any] | None:
        """Load skill row and return pipeline_config if present and non-empty."""
        resp = self._client.table("skills").select("id, pipeline_config").eq("id", skill_id).execute()
        if not resp.data or len(resp.data) == 0:
            return None
        row = resp.data[0]
        config = row.get("pipeline_config")
        if not config or not isinstance(config, dict):
            return None
        if not config.get("steps"):
            return None
        return config

    async def run(
        self,
        skill_id: str,
        prompt: str,
        entity_name: str | None = None,
        persona: dict[str, Any] | None = None,
    ) -> str:
        """
        If skill has pipeline_config with steps, run the pipeline.
        Otherwise returns empty string (caller can fall back to legacy behavior).
        """
        config = self.get_skill_config(skill_id)
        if not config:
            return ""

        context = {
            "prompt": prompt,
            "entity_name": entity_name,
            "persona": persona,
        }
        return await run_pipeline(config, context, self._router)
