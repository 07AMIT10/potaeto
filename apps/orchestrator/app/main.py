from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.router.model_router import ModelRouter, TaskType
from app.providers.base import TextMessage
from app.skills.service import SkillsService


app = FastAPI(title="Potaeto Orchestrator")
router = ModelRouter()
skills_service = SkillsService(router=router, supabase=router._supabase)


@app.on_event("startup")
async def startup_event() -> None:
    """Warm caches on startup so the first request doesn't pay the full DB cost."""
    for task in ("chat_primary", "summarize", "skill_text"):
        try:
            router._models_cache.get(task)
        except Exception:
            ...


@app.get("/v1/health")
async def health_check() -> Any:
    """Provider health snapshot for admin dashboard."""
    return {
        "status": "ok",
        "providers": router.health.snapshot_all(),
    }


@app.post("/v1/cache/invalidate")
async def invalidate_cache() -> Any:
    """Force-refresh cached models_config and skills. Call after admin changes."""
    router.invalidate_cache()
    SkillsService._cache.clear()
    return {"status": "ok", "message": "Caches invalidated"}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    task_type: TaskType = "chat_primary"
    messages: list[ChatMessage]


class ChatResponse(BaseModel):
    content: str


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> Any:
    msgs = [TextMessage(role=m.role, content=m.content) for m in req.messages]
    result = await router.generate_text(task_type=req.task_type, messages=msgs)
    return ChatResponse(content=result.content)


async def _chat_stream_generator(req: ChatRequest):
    msgs = [TextMessage(role=m.role, content=m.content) for m in req.messages]
    async for chunk in router.generate_text_stream(task_type=req.task_type, messages=msgs):
        if isinstance(chunk, str):
            yield chunk.encode("utf-8")
        else:
            yield chunk


@app.post("/v1/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    """Stream chat response as plain text chunks. Client can use getReader() for token-by-token UX."""
    return StreamingResponse(
        _chat_stream_generator(req),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class SummarizeRequest(BaseModel):
    existing_summary: str | None = None
    transcript: str


class SummarizeResponse(BaseModel):
    summary: str
    facts: list[str]


@app.post("/v1/summarize", response_model=SummarizeResponse)
async def summarize(req: SummarizeRequest) -> Any:
    system_message = TextMessage(
        role="system",
        content=(
            "You are a memory distiller for a chatbot.\n\n"
            "Task: Update a running conversation summary AND extract long-term facts "
            "about the user and their relationship with the assistant.\n\n"
            "Rules:\n"
            "- Summary should capture stable, useful information (user preferences, "
            "goals, constraints, ongoing projects).\n"
            "- Facts: short bullet-style statements, each focusing on one preference, "
            "goal, constraint, or important event.\n"
            "- Do NOT include secrets like passwords, API keys, emails, phone numbers.\n"
            "- Output MUST be valid JSON with this shape:\n"
            '{\"summary\": \"...\", \"facts\": [\"...\", \"...\"]}\n'
        ),
    )

    user_message = TextMessage(
        role="user",
        content=(
            f"Existing summary (may be empty):\n\"\"\"\n{req.existing_summary or ''}\n\"\"\"\n\n"
            f"New conversation transcript chunk:\n\"\"\"\n{req.transcript}\n\"\"\""
        ),
    )

    result = await router.generate_text(
        task_type="summarize",
        messages=[system_message, user_message],
    )

    raw = result.content.strip()
    # Best-effort JSON cleanup (clients can also sanitize, but we handle simple cases here)
    cleaned = raw.replace("```json", "").replace("```", "").strip()

    summary: str = ""
    facts: list[str] = []
    try:
        import json

        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            summary = str(parsed.get("summary") or "").strip()
            raw_facts = parsed.get("facts") or []
            if isinstance(raw_facts, list):
                facts = [str(f).strip() for f in raw_facts if str(f).strip()]
    except Exception:
        # Fallback: treat the entire content as the summary
        summary = cleaned

    return SummarizeResponse(summary=summary, facts=facts)


class SkillInvokeRequest(BaseModel):
    prompt: str
    entity_name: str | None = None
    persona: dict[str, Any] | None = None


class SkillInvokeResponse(BaseModel):
    output: str


@app.post("/v1/skills/{skill_id}/invoke", response_model=SkillInvokeResponse)
async def invoke_skill(skill_id: str, req: SkillInvokeRequest) -> Any:
    """Invoke a skill by id. Uses pipeline_config from DB when present, else legacy fallback."""
    pipeline_output = await skills_service.run(
        skill_id=skill_id,
        prompt=req.prompt,
        entity_name=req.entity_name,
        persona=req.persona,
    )
    if pipeline_output:
        return SkillInvokeResponse(output=pipeline_output)

    # Legacy fallback when skill has no pipeline_config (e.g. songwriter before seed)
    from app.skills.prompts import get_system_prompt

    template_id = "songwriter_v1" if skill_id == "songwriter" else None
    system_content = get_system_prompt(template_id)
    persona_suffix = ""
    if req.entity_name:
        persona_suffix += f'\nThe output is for the persona "{req.entity_name}".'
    if req.persona:
        persona_suffix += f"\nPersona details (JSON): {req.persona}"
    system_message = TextMessage(role="system", content=f"{system_content}{persona_suffix}")
    user_message = TextMessage(role="user", content=req.prompt)
    result = await router.generate_text(
        task_type="skill_text",
        messages=[system_message, user_message],
    )
    return SkillInvokeResponse(output=result.content.strip())


ENTITY_JSON_SCHEMA = """
Return a single JSON object (no markdown, no code fence) with exactly these keys:
- name: string (short name for the character/persona)
- slug: string (lowercase, hyphenated, e.g. "chef-mario")
- characteristics: object with optional keys age, role, background (strings)
- appearance: object with optional key description (string), reference_image_urls (array of strings if any)
- persona: object with optional keys tone, style, catchphrases (array), dialogue_examples (array of strings)
- skills: array of strings (e.g. ["cooking", "storytelling"])
- attributes: object with optional key-value pairs (e.g. humor: 0.8, formal: 0.2)
""".strip()


class ParseEntityRequest(BaseModel):
    text: str


class ParsedEntity(BaseModel):
    name: str
    slug: str
    characteristics: dict[str, Any] | None = None
    appearance: dict[str, Any] | None = None
    persona: dict[str, Any] | None = None
    skills: list[str] | None = None
    attributes: dict[str, Any] | None = None


@app.post("/v1/parse-entity", response_model=ParsedEntity)
async def parse_entity(req: ParseEntityRequest) -> Any:
    system_message = TextMessage(
        role="system",
        content=(
            "The user is describing a character or persona they want to create "
            '("WHO and WHAT"). Extract structured data from their description.\n\n'
            f"{ENTITY_JSON_SCHEMA}"
        ),
    )
    user_message = TextMessage(
        role="user",
        content=f'User description:\n"""\n{req.text}\n"""',
    )

    result = await router.generate_text(
        task_type="chat_primary",
        messages=[system_message, user_message],
    )

    raw = result.content.strip()
    cleaned = raw.replace("```json", "").replace("```", "").strip()

    import json

    data = json.loads(cleaned)
    return ParsedEntity(
        name=data["name"],
        slug=data["slug"],
        characteristics=data.get("characteristics") or {},
        appearance=data.get("appearance") or {},
        persona=data.get("persona") or {},
        skills=data.get("skills") or [],
        attributes=data.get("attributes") or {},
    )


class ProactiveRequest(BaseModel):
    entity_name: str
    persona: dict[str, Any] | None = None
    summary: str | None = None
    recent_facts: list[str] | None = None
    topic: str | None = None


class ProactiveResponse(BaseModel):
    message: str


@app.post("/v1/proactive", response_model=ProactiveResponse)
async def proactive_message(req: ProactiveRequest) -> Any:
    """Generate a short, in-character proactive message from the entity to the user."""
    context_parts = [
        f'You are "{req.entity_name}", a character/persona.',
    ]
    if req.persona:
        context_parts.append(f"Persona: {req.persona}")
    if req.summary:
        context_parts.append(f"Conversation summary so far: {req.summary}")
    if req.recent_facts:
        facts = "\n".join(f"- {f}" for f in req.recent_facts)
        context_parts.append(f"Known facts about the user:\n{facts}")

    context_parts.append(
        "\nGenerate a single short, friendly message to re-engage the user. "
        "Options: ask how their day was, ask about something they mentioned, "
        "share something interesting in character, or just say hi warmly. "
        "One to two sentences max. No lists, no bullet points. Stay in character."
    )

    if req.topic:
        context_parts.append(f'\nSpecifically ask about or reference: "{req.topic}"')

    system_message = TextMessage(role="system", content="\n".join(context_parts))
    user_message = TextMessage(role="user", content="Generate the proactive message now.")

    result = await router.generate_text(
        task_type="proactive_message",
        messages=[system_message, user_message],
    )
    return ProactiveResponse(message=result.content.strip())

