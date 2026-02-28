from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from app.router.model_router import ModelRouter, TaskType
from app.providers.base import TextMessage


app = FastAPI(title="Potaeto Orchestrator")
router = ModelRouter()


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
    """Generic skill invocation endpoint.

    For now, we implement a first concrete skill: `songwriter`.
    Other skills can be added by extending the system prompt logic here
    or by delegating to a dedicated skills service.
    """
    base_system = (
        "You are an AI assistant.\n"
        "Follow the skill-specific instructions to produce the best output."
    )

    if skill_id == "songwriter":
        system_instructions = (
            "You are a creative songwriter helping a user craft lyrics.\n"
            "Write singable, emotionally engaging lyrics.\n"
            "Respect any style, mood, or constraints given by the user.\n"
            "Keep the output as lyrics only (no explanations)."
        )
    else:
        system_instructions = (
            "You are a helpful assistant.\n"
            "The user is invoking a generic skill; respond with your best effort."
        )

    persona_suffix = ""
    if req.entity_name:
        persona_suffix += f'\nThe lyrics are for the persona "{req.entity_name}".'
    if req.persona:
        persona_suffix += f"\nPersona details (JSON): {req.persona}"

    system_message = TextMessage(
        role="system",
        content=f"{base_system}\n\n{system_instructions}{persona_suffix}",
    )

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

