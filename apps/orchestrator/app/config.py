from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os

from dotenv import load_dotenv


load_dotenv()  # load .env.orchestrator or .env if present


@dataclass
class SupabaseSettings:
    url: str
    anon_key: str


@dataclass
class GeminiSettings:
    api_key: str


@dataclass
class AppSettings:
    supabase: SupabaseSettings
    gemini: GeminiSettings


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")

    if not supabase_url or not supabase_key:
        raise RuntimeError("Supabase URL / anon key not configured for orchestrator")

    gemini_key = os.environ.get("GOOGLE_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not gemini_key:
        raise RuntimeError("Gemini API key not configured for orchestrator")

    return AppSettings(
        supabase=SupabaseSettings(url=supabase_url, anon_key=supabase_key),
        gemini=GeminiSettings(api_key=gemini_key),
    )

