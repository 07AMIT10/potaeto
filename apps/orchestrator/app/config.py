from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
import os

from dotenv import load_dotenv


load_dotenv()


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


def _env_float(key: str, default: float) -> float:
    v = os.environ.get(key, "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _env_list(key: str, default: list[str] | None = None) -> list[str]:
    """Comma-separated list from env var."""
    v = os.environ.get(key, "").strip()
    if not v:
        return default or []
    return [item.strip() for item in v.split(",") if item.strip()]


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
def get_settings() -> AppSettings:
    supabase_url = _env_str("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    # Prefer service role key so orchestrator can read models_config (RLS is admin-only)
    service_role_key = _env_str("SUPABASE_SERVICE_ROLE_KEY")
    anon_key = _env_str("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
    supabase_key = service_role_key or anon_key
    if not supabase_url or not supabase_key:
        raise RuntimeError("Supabase URL and key (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY) not configured for orchestrator")

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
        supabase=SupabaseSettings(url=supabase_url, anon_key=anon_key, service_role_key=service_role_key),
        gemini=GeminiSettings(api_key=gemini_key),
        health=health,
        routing=routing,
    )
