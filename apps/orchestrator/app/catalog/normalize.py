"""Catalog normalization.

Converts the raw discovery payloads from OpenCode Go, OpenRouter, and
``models.dev`` into the canonical ``ModelInfo`` shape, deriving a single
``protocol`` token and per-protocol ``base_url`` from OpenCode's ``api`` map.

OpenCode's live ``api`` field is an object keyed by protocol
(``chat-completions``, ``responses``, ``messages``, ``generate-content``), each
entry carrying a ``base_url``. The per-model fields are ``limit.context``,
``limit.output``, ``capabilities.tools.supported``, and ``cost``.
"""

from __future__ import annotations

from typing import Any

from app.providers.base import ModelInfo

# Maps OpenCode's ``api`` keys to canonical protocol tokens. Iteration order is
# the preference order when a model exposes more than one protocol.
_API_PROTOCOL_TOKENS: dict[str, str] = {
    "chat-completions": "openai",
    "responses": "responses",
    "messages": "messages",
    "generate-content": "google",
}


def protocol_from_api(api: dict[str, Any]) -> str:
    """Map the live ``api`` object (keyed by protocol) to a canonical token.

    Returns one of ``"openai"`` (chat completions), ``"responses"``,
    ``"messages"`` or ``"google"`` (native fallback targets).
    """
    if not isinstance(api, dict):
        return "openai"
    for key, token in _API_PROTOCOL_TOKENS.items():
        if key in api:
            return token
    return "openai"


def api_base_url(api: dict[str, Any]) -> str | None:
    """Return the ``base_url`` of the model's primary protocol (or ``None``)."""
    if not isinstance(api, dict):
        return None
    for key in _API_PROTOCOL_TOKENS:
        entry = api.get(key)
        if isinstance(entry, dict) and entry.get("base_url"):
            return str(entry["base_url"])
    return None


def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def opencode_model_to_info(model: dict[str, Any]) -> ModelInfo | None:
    model_id = model.get("id")
    if not model_id:
        return None

    api = model.get("api")
    api = api if isinstance(api, dict) else {}
    limit = model.get("limit")
    limit = limit if isinstance(limit, dict) else {}
    capabilities = model.get("capabilities")
    capabilities = capabilities if isinstance(capabilities, dict) else {}

    # Live names first, legacy names as fallbacks.
    context = model.get("context_length")
    if context is None:
        context = limit.get("context")

    max_output = model.get("max_output_tokens")
    if max_output is None:
        max_output = model.get("max_completion_tokens")
    if max_output is None:
        max_output = limit.get("output")

    supports_tools = model.get("supports_tools")
    if supports_tools is None:
        tools = capabilities.get("tools")
        supports_tools = (
            bool(tools.get("supported")) if isinstance(tools, dict) else False
        )

    pricing = model.get("pricing")
    if pricing is None and isinstance(model.get("cost"), dict):
        pricing = model["cost"]

    retention = model.get("retention") or model.get("data_retention")

    return ModelInfo(
        provider="opencode_go",
        id=str(model_id),
        name=str(model.get("name") or model_id),
        context_length=_coerce_int(context),
        max_output_tokens=_coerce_int(max_output),
        supports_tools=bool(supports_tools),
        protocol=protocol_from_api(api),
        pricing=pricing,
        retention=str(retention) if retention else None,
        base_url=api_base_url(api),
    )


def normalize_opencode_models(payload: dict[str, Any]) -> list[ModelInfo]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    models: list[ModelInfo] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        info = opencode_model_to_info(entry)
        if info is not None:
            models.append(info)
    return models


def openrouter_model_to_info(model: dict[str, Any]) -> ModelInfo | None:
    model_id = model.get("id")
    if not model_id:
        return None

    pricing = model.get("pricing") if isinstance(model.get("pricing"), dict) else {}
    supported = model.get("supported_parameters") or []

    max_output = model.get("max_completion_tokens")
    if max_output is None:
        top_provider = model.get("top_provider") or {}
        if isinstance(top_provider, dict):
            max_output = top_provider.get("max_completion_tokens")

    return ModelInfo(
        provider="openrouter",
        id=str(model_id),
        name=str(model.get("name") or model_id),
        context_length=_coerce_int(model.get("context_length")),
        max_output_tokens=_coerce_int(max_output),
        supports_tools=bool(model.get("tools"))
        if model.get("tools") is not None
        else ("tools" in supported),
        protocol="openai",
        pricing=pricing or None,
        retention=None,
    )


def normalize_openrouter_models(payload: dict[str, Any]) -> list[ModelInfo]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    models: list[ModelInfo] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        info = openrouter_model_to_info(entry)
        if info is not None:
            models.append(info)
    return models


def normalize_models_dev(payload: dict[str, Any]) -> list[ModelInfo]:
    """Project ``models.dev/api.json`` (a flat provider map) into ``ModelInfo``.

    The live document has no ``providers`` wrapper: providers are indexed
    directly and each provider's ``models`` is a dict keyed by model id.
    ``models.dev`` is a metadata fallback only — never authoritative for the
    live Go-plan lineup.
    """
    if not isinstance(payload, dict):
        return []
    for key in ("opencode-go", "opencode_go"):
        provider = payload.get(key)
        if not isinstance(provider, dict):
            continue
        models = provider.get("models")
        if isinstance(models, dict):
            return _models_dev_models(models)
    return []


def _models_dev_models(models: dict[str, Any]) -> list[ModelInfo]:
    out: list[ModelInfo] = []
    for model_id, entry in models.items():
        if not isinstance(entry, dict):
            continue
        limit = entry.get("limit")
        limit = limit if isinstance(limit, dict) else {}
        cost = entry.get("cost")
        out.append(
            ModelInfo(
                provider="opencode_go",
                id=str(model_id),
                name=str(entry.get("name") or model_id),
                context_length=_coerce_int(limit.get("context")),
                max_output_tokens=_coerce_int(limit.get("output")),
                supports_tools=bool(entry.get("tool_call")),
                protocol="openai",
                pricing=cost if isinstance(cost, dict) else None,
                retention=None,
            )
        )
    return out


# Bundled fallback snapshot. This is deliberately empty until the live catalog
# is captured: shipping guessed model IDs would mislead the model picker. The
# discovery chain still reaches this step (and returns [] rather than raising)
# when every network source is unavailable.
BUNDLED_SNAPSHOT: list[dict[str, Any]] = []


def snapshot_models() -> list[ModelInfo]:
    out: list[ModelInfo] = []
    for entry in BUNDLED_SNAPSHOT:
        info = opencode_model_to_info(entry)
        if info is not None:
            out.append(info)
    return out
