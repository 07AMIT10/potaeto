from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

DEFAULT_DB_PATH = "data/potaeto.db"


@dataclass(frozen=True)
class OpenCodeSettings:
    """OpenCode Go provider settings."""

    api_key: str = ""
    base_url: str = ""
    session_id: str = ""


@dataclass(frozen=True)
class OpenRouterSettings:
    """OpenRouter provider settings."""

    api_key: str = ""
    base_url: str = ""
    http_referer: str = ""
    app_title: str = "Potaeto"


@dataclass(frozen=True)
class TelegramSettings:
    """Optional Telegram remote control.

    The bot is fail-closed: it starts only when both a token and at least one
    allowed chat id are configured. Every other chat is ignored without a reply.
    """

    bot_token: str = ""
    allowed_chat_ids: list[int] = field(default_factory=list)

    @property
    def enabled(self) -> bool:
        return bool(self.bot_token and self.allowed_chat_ids)


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the core API."""

    db_path: str | Path = DEFAULT_DB_PATH
    version: str = "0.1.0"
    app_name: str = "Potaeto Core"
    model: str = ""
    #: Preferred provider name (``opencode_go``, ``openrouter``). Empty means
    #: registration order, with the provider that actually lists ``model``
    #: promoted first.
    provider: str = ""
    #: Cap on tokens the provider may generate per call. Required in practice:
    #: OpenRouter treats a missing ``max_tokens`` as the model maximum and
    #: rejects the request when the account cannot cover it.
    max_output_tokens: int = 4096
    #: Memory scope used for retrieval. A project scope (``project:Anveshak``)
    #: widens retrieval to that project plus global; ``global`` means global only.
    memory_scope: str = "project:Anveshak"
    #: Upper bound on the assembled-context token budget, regardless of how
    #: large the selected model's catalog window is.
    context_ceiling_tokens: int = 32000
    #: Lower bound so a small context window still leaves room to answer.
    context_floor_tokens: int = 4000
    #: Canonical markdown memory tree. Empty disables the startup indexer; the
    #: CLI (``python -m app.cli index-memory``) still works on demand.
    memory_dir: str = ""
    #: ``Secure`` on the device cookie. Defaults on for production; local dev
    #: over plain HTTP opts out with ``POTAETO_COOKIE_SECURE=0``.
    cookie_secure: bool = True
    cors_origins: list[str] = field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ]
    )
    #: Run the background job runner. Off by default so tests and one-off CLI
    #: commands never start a worker by accident.
    scheduler_enabled: bool = False
    #: Register the offline provider used by ``scripts/smoke.sh``. This is a
    #: test-only switch and must stay unset in production.
    smoke_provider: bool = False
    #: Per-caller request budgets, both over a 60-second window.
    rate_limit_pair_per_min: int = 10
    rate_limit_chat_per_min: int = 30
    #: Path to standalone Lens MCP sidecar binary (or empty for auto-detect).
    lens_mcp_path: str = ""
    opencode: OpenCodeSettings = field(default_factory=OpenCodeSettings)
    openrouter: OpenRouterSettings = field(default_factory=OpenRouterSettings)
    telegram: TelegramSettings = field(default_factory=TelegramSettings)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load core settings from the environment."""
    return Settings(
        db_path=_env_str("POTAETO_DB_PATH", default=DEFAULT_DB_PATH),
        model=_env_str("POTAETO_MODEL"),
        provider=_env_str("POTAETO_PROVIDER"),
        max_output_tokens=_env_positive_int("POTAETO_MAX_OUTPUT_TOKENS", 4096),
        memory_scope=_env_str("POTAETO_MEMORY_SCOPE", default="project:Anveshak"),
        context_ceiling_tokens=_env_positive_int("POTAETO_CONTEXT_CEILING", 32000),
        context_floor_tokens=_env_positive_int("POTAETO_CONTEXT_FLOOR", 4000),
        memory_dir=_env_str("POTAETO_MEMORY_DIR"),
        cookie_secure=_env_bool("POTAETO_COOKIE_SECURE", default=True),
        cors_origins=_env_list(
            "POTAETO_CORS_ORIGINS",
            [
                "http://localhost:3000",
                "http://127.0.0.1:3000",
                "http://localhost:8080",
                "http://127.0.0.1:8080",
                "http://tauri.localhost",
                "https://tauri.localhost",
                "tauri://localhost",
            ],
        ),
        scheduler_enabled=_env_bool("POTAETO_SCHEDULER_ENABLED"),
        smoke_provider=_env_bool("POTAETO_SMOKE_PROVIDER"),
        rate_limit_pair_per_min=_env_int("RATE_LIMIT_PAIR_PER_MIN", 10),
        rate_limit_chat_per_min=_env_int("RATE_LIMIT_CHAT_PER_MIN", 30),
        lens_mcp_path=_env_str("LENS_MCP_PATH", default=""),
        opencode=OpenCodeSettings(
            api_key=_env_str("OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"),
            base_url=_env_str("OPENCODE_BASE_URL"),
            session_id=_env_str("OPENCODE_SESSION_ID"),
        ),
        openrouter=OpenRouterSettings(
            api_key=_env_str("OPENROUTER_API_KEY"),
            base_url=_env_str("OPENROUTER_BASE_URL"),
            http_referer=_env_str("OPENROUTER_HTTP_REFERER"),
            app_title=_env_str("OPENROUTER_APP_TITLE", default="Potaeto"),
        ),
        telegram=TelegramSettings(
            bot_token=_env_str("TELEGRAM_BOT_TOKEN"),
            allowed_chat_ids=_env_int_list("TELEGRAM_ALLOWED_CHAT_IDS"),
        ),
    )


def _env_str(key: str, *fallback_keys: str, default: str = "") -> str:
    for k in (key, *fallback_keys):
        v = os.environ.get(k, "").strip()
        if v:
            return v
    return default


def _env_int(key: str, default: int) -> int:
    v = os.environ.get(key, "").strip()
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _env_positive_int(key: str, default: int) -> int:
    """Read an int from env, falling back to ``default`` unless it is positive."""
    value = _env_int(key, default)
    return value if value > 0 else default


def _env_float(key: str, default: float) -> float:
    v = os.environ.get(key, "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _env_bool(key: str, default: bool = False) -> bool:
    """Read a truthy env flag (``1``, ``true``, ``yes``, ``on``)."""
    v = os.environ.get(key, "").strip().lower()
    if not v:
        return default
    return v in {"1", "true", "yes", "on"}


def _env_list(key: str, default: list[str] | None = None) -> list[str]:
    """Comma-separated list from env var."""
    v = os.environ.get(key, "").strip()
    if not v:
        return default or []
    return [item.strip() for item in v.split(",") if item.strip()]


def _env_int_list(key: str) -> list[int]:
    """Comma-separated integer list; invalid entries are dropped."""
    values: list[int] = []
    for item in _env_list(key):
        try:
            values.append(int(item))
        except ValueError:
            continue
    return values


@dataclass
class SupabaseSettings:
    url: str
    anon_key: str
    service_role_key: str = ""


@dataclass
class GeminiSettings:
    api_key: str = ""


@dataclass
class HealthSettings:
    """Tunable thresholds for the smart routing health tracker."""

    rolling_window_size: int = 30
    rate_limit_base_backoff: float = 15.0
    rate_limit_max_backoff: float = 300.0
    error_base_backoff: float = 3.0
    error_max_backoff: float = 30.0
    healthy_threshold: float = 0.90
    degraded_threshold: float = 0.50
    degraded_penalty: int = 50
    unhealthy_penalty: int = 200
    error_message_max_len: int = 500


@dataclass
class RoutingSettings:
    """Provider and model routing configuration."""

    enabled_providers: list[str] = field(
        default_factory=lambda: [
            "gemini",
            "groq",
            "cerebras",
            "sambanova",
            "openrouter",
            "huggingface",
        ]
    )
    default_priority: int = 100
    default_task_type: str = "skill_text"
    default_postprocess_kind: str = "trim"
    models_config_cache_ttl_sec: int = 60


@dataclass
class AppSettings:
    supabase: SupabaseSettings
    gemini: GeminiSettings
    health: HealthSettings
    routing: RoutingSettings


@lru_cache(maxsize=1)
def get_app_settings() -> AppSettings:
    """Legacy Supabase-era settings, kept until the provider rewrite lands."""
    supabase_url = _env_str("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    # Prefer service role key so orchestrator can read models_config (RLS is admin-only)
    service_role_key = _env_str("SUPABASE_SERVICE_ROLE_KEY")
    anon_key = _env_str("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
    supabase_key = service_role_key or anon_key
    if not supabase_url or not supabase_key:
        raise RuntimeError(
            "Supabase URL and key (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY) not configured for orchestrator"
        )

    gemini_key = _env_str("GOOGLE_GEMINI_API_KEY", "GEMINI_API_KEY")

    health = HealthSettings(
        rolling_window_size=_env_int("HEALTH_ROLLING_WINDOW_SIZE", 30),
        rate_limit_base_backoff=_env_float("HEALTH_RATE_LIMIT_BASE_BACKOFF", 15.0),
        rate_limit_max_backoff=_env_float("HEALTH_RATE_LIMIT_MAX_BACKOFF", 300.0),
        error_base_backoff=_env_float("HEALTH_ERROR_BASE_BACKOFF", 3.0),
        error_max_backoff=_env_float("HEALTH_ERROR_MAX_BACKOFF", 30.0),
        healthy_threshold=_env_float("HEALTH_HEALTHY_THRESHOLD", 0.90),
        degraded_threshold=_env_float("HEALTH_DEGRADED_THRESHOLD", 0.50),
        degraded_penalty=_env_int("HEALTH_DEGRADED_PENALTY", 50),
        unhealthy_penalty=_env_int("HEALTH_UNHEALTHY_PENALTY", 200),
        error_message_max_len=_env_int("HEALTH_ERROR_MESSAGE_MAX_LEN", 500),
    )

    routing = RoutingSettings(
        enabled_providers=_env_list(
            "ENABLED_PROVIDERS",
            ["gemini", "groq", "cerebras", "sambanova", "openrouter", "huggingface"],
        ),
        default_priority=_env_int("MODEL_DEFAULT_PRIORITY", 100),
        default_task_type=_env_str("DEFAULT_TASK_TYPE", default="skill_text"),
        default_postprocess_kind=_env_str("DEFAULT_POSTPROCESS_KIND", default="trim"),
        models_config_cache_ttl_sec=_env_int("MODELS_CONFIG_CACHE_TTL_SEC", 60),
    )

    return AppSettings(
        supabase=SupabaseSettings(
            url=supabase_url, anon_key=anon_key, service_role_key=service_role_key
        ),
        gemini=GeminiSettings(api_key=gemini_key),
        health=health,
        routing=routing,
    )
