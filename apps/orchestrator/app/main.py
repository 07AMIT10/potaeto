"""Potaeto core application factory."""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agent.factory import build_agent_loop, choices_from_state
from app.agent.loop import TurnQueue
from app.api.admin import router as admin_router
from app.api.approvals import router as approvals_router
from app.api.auth import router as auth_router
from app.api.chat import router as chat_router
from app.api.errors import install_error_handlers
from app.api.hardware import router as hardware_router
from app.api.health import router as health_router
from app.api.jobs import router as jobs_router
from app.api.memory import router as memory_router
from app.api.models import router as models_router
from app.api.sync import router as sync_router
from app.api.voice import router as voice_router
from app.config import Settings, get_settings
from app.db.connection import connect_db, run_migrations
from app.memory.indexer import MemoryIndexer
from app.model_selection import read_active_selection, select_providers
from app.providers.registry import ProviderRegistry, first_model_info
from app.scheduler.runner import JobRunner, Notify, Scheduler
from app.security.ratelimit import RateLimiter
from app.telegram.bot import TelegramBot
from app.telegram.client import TelegramClient
from app.telegram.notify import send_notification

logger = logging.getLogger(__name__)


def _configure_logging() -> None:
    """Make ``app.*`` INFO logs visible under uvicorn/systemd.

    Uvicorn configures only its own loggers; left alone, the application tree
    falls back to the last-resort handler, which drops everything below WARNING
    — the reason ``context turn …`` never reached journald.
    """
    logging.getLogger("app").setLevel(logging.INFO)
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
    if root.getEffectiveLevel() > logging.INFO:
        root.setLevel(logging.INFO)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the core app: open the database, migrate, and mount routes."""
    _configure_logging()
    settings = settings or get_settings()

    db = connect_db(settings.db_path)
    run_migrations(db)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await _initialize_agent_state(app)
        index_task = _start_memory_indexer(app)
        bot_task = None
        if settings.telegram.enabled:
            bot_task = _start_telegram_bot(app)
        runner_task = _start_job_runner(app) if settings.scheduler_enabled else None
        try:
            yield
        finally:
            if runner_task is not None:
                runner_task.cancel()
                with suppress(asyncio.CancelledError):
                    await runner_task
            if bot_task is not None:
                bot_task.cancel()
                with suppress(asyncio.CancelledError):
                    await bot_task
            if index_task is not None:
                # The indexer runs in a thread; wait for it (bounded) instead of
                # cancelling and closing the shared connection underneath it.
                with suppress(asyncio.TimeoutError, asyncio.CancelledError):
                    await asyncio.wait_for(asyncio.shield(index_task), timeout=30)
            await _close_telegram_bot(app)
            await _close_job_notifier(app)
            db.close()

    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        lifespan=lifespan,
        # Release 1 authenticates every endpoint except pairing/health; the
        # public schema and interactive docs would bypass that promise.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    # The PWA is same-origin in production (Caddy proxies /v1/*); in development
    # it runs on localhost:3000 against the core on localhost:8000, so the dev
    # origin needs CORS with credentials (the HttpOnly auth cookie).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.db = db
    app.state.settings = settings
    app.state.started_at = time.monotonic()
    app.state.providers = ProviderRegistry.from_settings(settings)
    app.state.model = settings.model
    app.state.provider_candidates = []
    app.state.model_info = None
    app.state.turn_queue = TurnQueue()
    app.state.rate_limiter = RateLimiter()
    app.state.telegram_bot = None
    app.state.scheduler = Scheduler(db)
    app.state.job_runner = None
    app.state.job_notify_client = None

    install_error_handlers(app)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(sync_router)
    app.include_router(jobs_router)
    app.include_router(models_router)
    app.include_router(memory_router)
    app.include_router(chat_router)
    app.include_router(voice_router)
    app.include_router(approvals_router)
    app.include_router(hardware_router)
    return app


async def _initialize_agent_state(app: FastAPI) -> None:
    """Resolve the active model against provider catalogs before serving.

    A stored picker selection wins over ``POTAETO_MODEL`` so the UI choice
    survives a restart. A model missing from the preferred provider's catalog
    logs a warning and the next provider is tried; a slow catalog lookup times
    out rather than delaying startup indefinitely.
    """
    state = app.state
    stored = read_active_selection(state.db)
    model = (stored[0] if stored else "") or state.settings.model
    provider = (stored[1] if stored else "") or state.settings.provider
    if not model:
        if getattr(state.providers, "names", list)():
            logger.warning(
                "no POTAETO_MODEL configured; chat requests will fail until a "
                "model is set or picked"
            )
        return
    choices = await select_providers(state.providers, model, provider)
    state.model = model
    state.provider_candidates = choices
    state.model_info = first_model_info(choices)
    if not choices:
        logger.warning("model %r resolved to no provider", model)


def _start_memory_indexer(app: FastAPI) -> asyncio.Task | None:
    """Index ``POTAETO_MEMORY_DIR`` in the background when the tree exists."""
    configured = app.state.settings.memory_dir
    if not configured:
        return None
    root = Path(configured).expanduser()
    if not root.exists():
        logger.warning("memory dir %s does not exist; skipping index", root)
        return None

    async def index_once() -> None:
        try:
            changed = await asyncio.to_thread(
                MemoryIndexer(app.state.db).reindex, root
            )
            logger.info("memory index: %s node(s) updated from %s", changed, root)
        except Exception:
            logger.exception("memory index failed for %s", root)

    return asyncio.create_task(index_once(), name="memory-indexer")


def _start_telegram_bot(app: FastAPI) -> asyncio.Task | None:
    """Start long polling as an optional background task, when configured."""
    state = app.state
    choices = choices_from_state(state)
    if not choices:
        logger.warning("telegram: no provider configured; bot not started")
        return None

    bot = TelegramBot(
        TelegramClient(state.settings.telegram.bot_token),
        state.db,
        build_agent_loop(
            state.db,
            choices,
            state.model,
            queue=state.turn_queue,
            max_tokens=state.settings.max_output_tokens,
            settings=state.settings,
        ),
        set(state.settings.telegram.allowed_chat_ids),
    )
    state.telegram_bot = bot
    logger.info("telegram: bot started")
    return asyncio.create_task(bot.run_forever(), name="telegram-bot")


def _start_job_runner(app: FastAPI) -> asyncio.Task:
    """Start the durable job runner as an optional background task."""
    runner = JobRunner(app.state.scheduler, _telegram_notify(app))
    app.state.job_runner = runner
    logger.info("scheduler: job runner started")
    return asyncio.create_task(runner.run_forever(), name="job-runner")


def _telegram_notify(app: FastAPI) -> Notify | None:
    """Send `notify` steps to the allowlisted Telegram chats, when configured."""
    telegram = app.state.settings.telegram
    if not telegram.enabled:
        return None
    client = TelegramClient(telegram.bot_token)
    app.state.job_notify_client = client
    chat_ids = tuple(telegram.allowed_chat_ids)

    async def notify(text: str) -> None:
        # Chunk at Telegram's UTF-16 limit and keep one bad chat from
        # suppressing delivery to the remaining chats.
        await send_notification(client.send_message, chat_ids, text)

    return notify


async def _close_job_notifier(app: FastAPI) -> None:
    client = getattr(app.state, "job_notify_client", None)
    if client is not None:
        await client.aclose()


async def _close_telegram_bot(app: FastAPI) -> None:
    bot = getattr(app.state, "telegram_bot", None)
    client = getattr(bot, "client", None)
    aclose = getattr(client, "aclose", None)
    if callable(aclose):
        await aclose()
        return
    close = getattr(client, "close", None)
    if callable(close):
        close()


app = create_app(get_settings())
