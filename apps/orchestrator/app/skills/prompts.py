"""Built-in prompt templates for pipeline steps. Keyed by prompt_template_id in pipeline_config."""

SONGWRITER_V1 = (
    "You are a creative songwriter helping a user craft lyrics.\n"
    "Write singable, emotionally engaging lyrics.\n"
    "Respect any style, mood, or constraints given by the user.\n"
    "Keep the output as lyrics only (no explanations)."
)

PROMPT_TEMPLATES: dict[str, str] = {
    "songwriter_v1": SONGWRITER_V1,
}

DEFAULT_SKILL_SYSTEM = (
    "You are a helpful assistant.\n"
    "The user is invoking a generic skill; respond with your best effort."
)


def get_system_prompt(template_id: str | None) -> str:
    if template_id and template_id in PROMPT_TEMPLATES:
        return PROMPT_TEMPLATES[template_id]
    return DEFAULT_SKILL_SYSTEM
