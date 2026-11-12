"""
SkillsService: load skill + pipeline_config from DB and execute steps.
Caches skill configs in memory with TTL to minimize DB queries on free tier.
"""
from __future__ import annotations

import time
from typing import Any, cast

from supabase import Client

from app.config import get_app_settings
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
    settings = get_app_settings()
    task_type = step.get("task_type") or settings.routing.default_task_type
    template_id = step.get("prompt_template_id")
    system_content = get_system_prompt(template_id)
    suffix = _build_context(context.get("entity_name"), context.get("persona"))
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
    settings = get_app_settings()
    kind = step.get("kind") or settings.routing.default_postprocess_kind
    if kind == "trim":
        return input_text.strip()
    return input_text


async def run_pipeline(
    pipeline_config: dict[str, Any],
    context: dict[str, Any],
    router: ModelRouter,
) -> str:
    steps = pipeline_config.get("steps") or []
    if not steps:
        return ""

    current: str = ""
    for step in steps:
        step_type = step.get("type") or "llm"

        if step_type == "llm":
            ctx = dict(context) if not current else {**context, "prompt": current}
            current = await _execute_llm_step(step, ctx, router)
        elif step_type == "postprocess":
            current = await _execute_postprocess_step(step, current)

    return current


class SkillsService:
    """
    Load skill from DB and run pipeline_config.
    Reuses the router's Supabase client and caches skill configs with TTL.
    """

    _cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
    _cache_ttl: int = 120  # seconds

    def __init__(self, router: ModelRouter, supabase: Client) -> None:
        self._router = router
        self._client = supabase

    def get_skill_config(self, skill_id: str) -> dict[str, Any] | None:
        now = time.monotonic()
        cached = self._cache.get(skill_id)
        if cached and (now - cached[0]) < self._cache_ttl:
            return cached[1]

        resp = self._client.table("skills").select("id, pipeline_config").eq("id", skill_id).execute()
        if not resp.data or len(resp.data) == 0:
            self._cache[skill_id] = (now, None)
            return None
        row = resp.data[0]
        config = row.get("pipeline_config")
        if not config or not isinstance(config, dict) or not config.get("steps"):
            self._cache[skill_id] = (now, None)
            return None
        self._cache[skill_id] = (now, config)
        return config

    async def run(
        self,
        skill_id: str,
        prompt: str,
        entity_name: str | None = None,
        persona: dict[str, Any] | None = None,
    ) -> str:
        config = self.get_skill_config(skill_id)
        if not config:
            return ""
        context = {"prompt": prompt, "entity_name": entity_name, "persona": persona}
        return await run_pipeline(config, context, self._router)
