"""Allowlisted Telegram remote interface.

The bot is tested against a fake Telegram client and a fake agent loop, so no
network or provider is involved. The contract is fail-closed: an unknown chat
is recorded but never answered, update ids are persisted before processing, and
a retry of an already-processed update is a no-op.
"""

from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agent.loop import AgentEvent
from app.config import Settings, TelegramSettings
from app.telegram.bot import MAX_AGENT_ATTEMPTS, DeliveryRetry, TelegramBot
from app.telegram.client import TelegramClient, TelegramError
from app.telegram.notify import send_notification
from app.telegram.text import MAX_MESSAGE_LENGTH

# Module-level so the controller's verbatim test bodies can stay unchanged.
update = {"update_id": 2, "message": {"chat": {"id": 123}, "text": "hi"}}


class FakeTelegramClient:
    """Records sends; returns no updates (long polling is scripted per test)."""

    def __init__(self) -> None:
        self.sent: list[tuple[int, str]] = []
        self.sent_messages: list[dict] = []
        self.answered_callbacks: list[dict] = []
        self.edited_messages: list[dict] = []
        self.offsets: list[int] = []
        self.updates: list[dict] = []

    def send_message(
        self, chat_id: int, text: str, *, reply_markup: dict | None = None, **kwargs
    ) -> dict:
        self.sent.append((chat_id, text))
        self.sent_messages.append(
            {"chat_id": chat_id, "text": text, "reply_markup": reply_markup, **kwargs}
        )
        return {"ok": True}

    def answer_callback_query(
        self, callback_query_id: str, text: str | None = None, **kwargs
    ) -> dict:
        self.answered_callbacks.append(
            {"callback_query_id": callback_query_id, "text": text, **kwargs}
        )
        return {"ok": True}

    def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        *,
        reply_markup: dict | None = None,
        **kwargs,
    ) -> dict:
        self.edited_messages.append(
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "reply_markup": reply_markup,
                **kwargs,
            }
        )
        return {"ok": True}

    async def get_updates(self, offset: int, timeout: int = 50) -> list[dict]:
        self.offsets.append(offset)
        return self.updates


class FakeLoop:
    """Streams a fixed reply and records how it was called."""

    model = "test-model"

    def __init__(self, reply: str = "Hi there") -> None:
        self.reply = reply
        self.calls: list[tuple[str, str]] = []
        self.conversation_ids: list[str] = []
        self.client_message_ids: list[str | None] = []

    async def run(
        self, conversation_id, user_message, channel="app", *, client_message_id=None
    ):
        self.calls.append((user_message, channel))
        self.conversation_ids.append(conversation_id)
        self.client_message_ids.append(client_message_id)
        yield AgentEvent.token(self.reply)
        yield AgentEvent.done("m_reply")


class FailingLoop(FakeLoop):
    async def run(self, *args, **kwargs):
        raise RuntimeError("agent exploded")
        yield  # pragma: no cover - makes this an async generator


class ObservingLoop(FakeLoop):
    """Reads the update row while processing, to prove insert-before-process."""

    def __init__(self, db) -> None:
        super().__init__()
        self.db = db
        self.rows_at_call: list[tuple[int, str | None]] = []

    async def run(self, *args, **kwargs):
        row = self.db.execute(
            "SELECT update_id, processed_at FROM telegram_updates"
        ).fetchone()
        self.rows_at_call.append((row["update_id"], row["processed_at"]))
        async for event in super().run(*args, **kwargs):
            yield event


@pytest.fixture()
def fake_client():
    return FakeTelegramClient()


@pytest.fixture()
def fake_loop():
    return FakeLoop()


@pytest.fixture()
def bot(db, fake_client, fake_loop):
    return TelegramBot(fake_client, db, fake_loop, {123})


# ── allowlist ──────────────────────────────────────────────────────────


async def test_allowlist_rejects_unknown_chat(bot):
    update = {"update_id": 1, "message": {"chat": {"id": 999}, "text": "hi"}}
    assert await bot.handle_update(update) is False
    assert bot.client.sent == []


async def test_allowed_chat_routes_to_agent(bot, fake_loop):
    update = {"update_id": 2, "message": {"chat": {"id": 123}, "text": "hi"}}
    assert await bot.handle_update(update) is True
    assert fake_loop.calls == [("hi", "telegram")]


async def test_reply_tokens_are_accumulated_into_one_message(bot, fake_loop):
    assert await bot.handle_update(update) is True
    assert bot.client.sent == [(123, "Hi there")]
    assert fake_loop.conversation_ids[0]
    assert fake_loop.client_message_ids[0] == "m_tg_2"


# ── durable update ids ─────────────────────────────────────────────────


async def test_update_id_is_persisted_before_ack(bot, db):
    await bot.handle_update(update)
    assert db.execute("SELECT update_id FROM telegram_updates").fetchone()[0] == 2
    assert db.execute("SELECT processed_at FROM telegram_updates").fetchone()[0]


async def test_update_is_inserted_before_the_agent_runs(db, fake_client):
    loop = ObservingLoop(db)
    bot = TelegramBot(fake_client, db, loop, {123})
    await bot.handle_update(update)
    assert loop.rows_at_call == [(2, None)]


async def test_duplicate_update_is_not_processed_twice(bot, fake_loop):
    assert await bot.handle_update(update) is True
    assert await bot.handle_update(update) is False
    assert fake_loop.calls == [("hi", "telegram")]
    assert len(bot.client.sent) == 1


async def test_failed_processing_leaves_update_unacked(db, fake_client):
    bot = TelegramBot(fake_client, db, FailingLoop(), {123})
    with pytest.raises(RuntimeError):
        await bot.handle_update(update)
    row = db.execute("SELECT processed_at FROM telegram_updates").fetchone()
    assert row["processed_at"] is None


async def test_run_forever_resumes_after_the_last_seen_update(
    db, fake_client, fake_loop
):
    class ScriptedClient(FakeTelegramClient):
        def __init__(self) -> None:
            super().__init__()
            self.batches = [
                [{"update_id": 10, "message": {"chat": {"id": 123}, "text": "hi"}}]
            ]

        async def get_updates(self, offset: int, timeout: int = 50) -> list[dict]:
            self.offsets.append(offset)
            if self.batches:
                return self.batches.pop(0)
            raise asyncio.CancelledError

    client = ScriptedClient()
    bot = TelegramBot(client, db, fake_loop, {123})
    with pytest.raises(asyncio.CancelledError):
        await bot.run_forever()
    assert client.offsets == [1, 11]
    assert fake_loop.calls == [("hi", "telegram")]


async def test_run_forever_retries_an_unacked_update(db, fake_client, fake_loop):
    class FlakyLoop(FakeLoop):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        async def run(self, *args, **kwargs):
            self.attempts += 1
            if self.attempts == 1:
                raise RuntimeError("transient")
            async for event in FakeLoop.run(self, *args, **kwargs):
                yield event

    failed = {"update_id": 5, "message": {"chat": {"id": 123}, "text": "hi"}}

    class ScriptedClient(FakeTelegramClient):
        def __init__(self) -> None:
            super().__init__()
            # The same update is redelivered; the second attempt succeeds.
            self.batches = [[failed], [failed]]

        async def get_updates(self, offset: int, timeout: int = 50) -> list[dict]:
            self.offsets.append(offset)
            if self.batches:
                return self.batches.pop(0)
            raise asyncio.CancelledError

    loop = FlakyLoop()
    bot = TelegramBot(ScriptedClient(), db, loop, {123}, retry_delay=0)
    with pytest.raises(asyncio.CancelledError):
        await bot.run_forever()
    assert loop.attempts == 2
    assert bot.client.offsets == [1, 1, 6]


async def test_agent_turn_failure_is_capped_then_acked(db, fake_client):
    """A permanently failing model turn must not re-run (and re-bill) forever."""

    class AlwaysFailingLoop(FakeLoop):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        async def run(self, *args, **kwargs):
            self.attempts += 1
            raise RuntimeError("provider exploded")
            yield  # pragma: no cover - async-generator marker

    loop = AlwaysFailingLoop()
    bot = TelegramBot(fake_client, db, loop, {123}, retry_delay=0)

    for _ in range(MAX_AGENT_ATTEMPTS - 1):
        with pytest.raises(RuntimeError):
            await bot.handle_update(update)
    assert loop.attempts == MAX_AGENT_ATTEMPTS - 1

    # The cap is hit: ack the update and send a short failure reply.
    assert await bot.handle_update(update) is False
    assert loop.attempts == MAX_AGENT_ATTEMPTS
    assert "something went wrong" in bot.client.sent[-1][1].lower()
    row = db.execute(
        "SELECT processed_at FROM telegram_updates WHERE update_id = 2"
    ).fetchone()
    assert row["processed_at"]

    # A later redelivery is a no-op and never touches the model again.
    assert await bot.handle_update(update) is False
    assert loop.attempts == MAX_AGENT_ATTEMPTS


# ── delivery failure classification ────────────────────────────────────


@pytest.mark.parametrize("status", [400, 403])
async def test_permanent_delivery_error_is_acked_without_retry(db, fake_loop, status):
    class RejectingClient(FakeTelegramClient):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        def send_message(self, chat_id: int, text: str) -> dict:
            self.attempts += 1
            raise TelegramError("rejected", status=status)

    client = RejectingClient()
    bot = TelegramBot(client, db, fake_loop, {123})

    assert await bot.handle_update(update) is False
    assert client.attempts == 1
    assert fake_loop.calls == [("hi", "telegram")]
    row = db.execute(
        "SELECT processed_at FROM telegram_updates WHERE update_id = 2"
    ).fetchone()
    assert row["processed_at"]

    # A permanent 4xx is never retried and never re-runs the agent.
    assert await bot.handle_update(update) is False
    assert client.attempts == 1
    assert fake_loop.calls == [("hi", "telegram")]


async def test_rate_limited_delivery_honors_retry_after_and_caches_reply(db, fake_loop):
    class RateLimitedClient(FakeTelegramClient):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        def send_message(self, chat_id: int, text: str) -> dict:
            self.attempts += 1
            raise TelegramError("rate limited", status=429, retry_after=7)

    client = RateLimitedClient()
    bot = TelegramBot(client, db, fake_loop, {123})

    with pytest.raises(DeliveryRetry) as excinfo:
        await bot.handle_update(update)
    assert excinfo.value.delay == 7
    row = db.execute("SELECT processed_at FROM telegram_updates").fetchone()
    assert row["processed_at"] is None
    assert fake_loop.calls == [("hi", "telegram")]

    # Telegram redelivers the same update; only the send is retried, the
    # already-assembled reply is reused.
    bot.client = FakeTelegramClient()
    assert await bot.handle_update(update) is True
    assert bot.client.sent == [(123, "Hi there")]
    assert fake_loop.calls == [("hi", "telegram")]
    row = db.execute("SELECT processed_at FROM telegram_updates").fetchone()
    assert row["processed_at"]


async def test_transient_delivery_failure_is_capped_then_acked(db, fake_loop):
    class AlwaysFailingClient(FakeTelegramClient):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        def send_message(self, chat_id: int, text: str) -> dict:
            self.attempts += 1
            raise TelegramError("network down")

    client = AlwaysFailingClient()
    bot = TelegramBot(client, db, fake_loop, {123}, retry_delay=0)

    for _ in range(2):
        with pytest.raises(DeliveryRetry):
            await bot.handle_update(update)
    assert client.attempts == 2
    assert fake_loop.calls == [("hi", "telegram")]

    # Third failure hits the cap: ack it instead of blocking the queue head.
    assert await bot.handle_update(update) is False
    assert client.attempts == 3
    assert fake_loop.calls == [("hi", "telegram")]
    row = db.execute("SELECT processed_at FROM telegram_updates").fetchone()
    assert row["processed_at"]

    assert await bot.handle_update(update) is False
    assert client.attempts == 3


async def test_run_forever_retries_the_send_without_rerunning_the_agent(db, fake_loop):
    class FlakySendClient(FakeTelegramClient):
        def __init__(self) -> None:
            super().__init__()
            self.send_attempts = 0
            self.batches = [[update], [update]]

        async def get_updates(self, offset: int, timeout: int = 50) -> list[dict]:
            self.offsets.append(offset)
            if self.batches:
                return self.batches.pop(0)
            raise asyncio.CancelledError

        def send_message(self, chat_id: int, text: str) -> dict:
            self.send_attempts += 1
            if self.send_attempts == 1:
                raise TelegramError("rate limited", status=429, retry_after=0)
            return super().send_message(chat_id, text)

    client = FlakySendClient()
    bot = TelegramBot(client, db, fake_loop, {123}, retry_delay=0)
    with pytest.raises(asyncio.CancelledError):
        await bot.run_forever()

    # Offset stayed at 1 for the 429 retry, then advanced past the update.
    assert client.offsets == [1, 1, 3]
    assert client.send_attempts == 2
    assert client.sent == [(123, "Hi there")]
    assert fake_loop.calls == [("hi", "telegram")]  # agent ran once


# ── splitting ──────────────────────────────────────────────────────────


async def test_long_message_is_split(bot):
    bot.send_long(123, "x" * 5000)
    assert len(bot.client.sent) == 2
    assert [len(text) for _, text in bot.client.sent] == [
        MAX_MESSAGE_LENGTH,
        5000 - MAX_MESSAGE_LENGTH,
    ]


def test_send_long_keeps_a_4096_char_message_intact(bot):
    bot.send_long(123, "x" * MAX_MESSAGE_LENGTH)
    assert len(bot.client.sent) == 1


def test_send_long_splits_by_utf16_code_units(bot):
    emoji = "😀" * 3000  # 3000 Python chars, 6000 UTF-16 code units
    bot.send_long(123, emoji)
    assert len(bot.client.sent) == 2
    for _, text in bot.client.sent:
        assert len(text.encode("utf-16-le")) // 2 <= MAX_MESSAGE_LENGTH
    assert "".join(text for _, text in bot.client.sent) == emoji


# ── commands ───────────────────────────────────────────────────────────


async def _send(bot, text, update_id=100):
    return await bot.handle_update(
        {
            "update_id": update_id,
            "message": {"chat": {"id": 123}, "text": text},
        }
    )


async def test_start_and_status_commands(bot):
    assert await _send(bot, "/start", 100) is True
    assert await _send(bot, "/status", 101) is True
    assert "online" in bot.client.sent[0][1].lower()
    assert "test-model" in bot.client.sent[1][1]
    assert "paused: no" in bot.client.sent[1][1].lower()


async def test_model_jobs_and_memory_commands_are_honest_stubs(bot, db):
    from app.db.repositories.jobs import JobRepo

    JobRepo(db).create("briefing", schedule="0 8 * * *")
    for idx, command in enumerate(("/model", "/jobs", "/memory"), start=110):
        assert await _send(bot, command, idx) is True
    model_reply, jobs_reply, memory_reply = (text for _, text in bot.client.sent)
    assert "test-model" in model_reply
    assert "later release" in model_reply
    assert "1 job" in jobs_reply
    assert "later release" in jobs_reply
    assert "memory" in memory_reply.lower()
    assert "later release" in memory_reply


async def test_pause_and_resume_block_free_text(bot, fake_loop):
    assert await _send(bot, "/pause", 120) is True
    assert await _send(bot, "hello", 121) is True
    assert fake_loop.calls == []
    assert "paused" in bot.client.sent[-1][1].lower()

    assert await _send(bot, "/resume", 122) is True
    assert await _send(bot, "hello", 123) is True
    assert fake_loop.calls == [("hello", "telegram")]


async def test_command_with_bot_suffix_is_recognized(bot):
    assert await _send(bot, "/status@potaeto_bot", 130) is True
    assert "status" in bot.client.sent[-1][1].lower()


async def test_non_text_update_is_acked_without_a_reply(bot):
    assert await bot.handle_update({"update_id": 140, "edited_message": {}}) is False
    assert bot.client.sent == []
    row = bot.db.execute(
        "SELECT processed_at FROM telegram_updates WHERE update_id = 140"
    ).fetchone()
    assert row["processed_at"]


# ── config and client ──────────────────────────────────────────────────


def test_telegram_settings_parse_allowlist(monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token-123")
    monkeypatch.setenv("TELEGRAM_ALLOWED_CHAT_IDS", "123, 456,not-a-number")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.telegram.bot_token == "token-123"
        assert settings.telegram.allowed_chat_ids == [123, 456]
        assert settings.telegram.enabled is True
    finally:
        get_settings.cache_clear()


def test_telegram_is_disabled_without_token_or_allowlist():
    assert TelegramSettings().enabled is False
    assert TelegramSettings(bot_token="t").enabled is False
    assert TelegramSettings(allowed_chat_ids=[1]).enabled is False
    assert TelegramSettings(bot_token="t", allowed_chat_ids=[1]).enabled is True


async def test_client_calls_telegram_and_redacts_the_token():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/getUpdates"):
            return httpx.Response(200, json={"ok": True, "result": [{"update_id": 7}]})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    async_http = httpx.AsyncClient(transport=transport)
    client = TelegramClient("super-secret-token", client=http, async_client=async_http)

    assert await client.get_updates(5, timeout=1) == [{"update_id": 7}]
    assert client.send_message(123, "hello") == {"message_id": 1}
    await client.aclose()
    assert json.loads(seen[0].content) == {"offset": 5, "timeout": 1}
    assert json.loads(seen[1].content) == {"chat_id": 123, "text": "hello"}
    assert seen[0].url.path.endswith("/botsuper-secret-token/getUpdates")
    assert "super-secret-token" not in repr(client)


async def test_client_errors_do_not_leak_the_token():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    transport = httpx.MockTransport(handler)
    client = TelegramClient(
        "super-secret-token",
        client=httpx.Client(transport=transport),
        async_client=httpx.AsyncClient(transport=transport),
    )

    with pytest.raises(TelegramError) as excinfo:
        await client.get_updates(0)
    assert "super-secret-token" not in str(excinfo.value)
    await client.aclose()


async def test_client_parses_429_retry_after():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={
                "ok": False,
                "error_code": 429,
                "parameters": {"retry_after": 7},
            },
        )

    transport = httpx.MockTransport(handler)
    client = TelegramClient(
        "super-secret-token",
        client=httpx.Client(transport=transport),
        async_client=httpx.AsyncClient(transport=transport),
    )

    with pytest.raises(TelegramError) as excinfo:
        await client.get_updates(0)
    error = excinfo.value
    assert error.status == 429
    assert error.retry_after == 7
    assert error.permanent is False
    assert "super-secret-token" not in str(error)
    await client.aclose()


async def test_client_classifies_403_as_permanent():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"ok": False, "error_code": 403})

    transport = httpx.MockTransport(handler)
    client = TelegramClient(
        "super-secret-token",
        client=httpx.Client(transport=transport),
        async_client=httpx.AsyncClient(transport=transport),
    )

    with pytest.raises(TelegramError) as excinfo:
        client.send_message(123, "hi")
    assert excinfo.value.status == 403
    assert excinfo.value.permanent is True
    await client.aclose()


# ── optional startup wiring ────────────────────────────────────────────


class _FakeRegistry:
    def names(self):
        return ["fake"]

    def get(self, name):
        return object()


def test_app_does_not_start_the_bot_when_unconfigured():
    from app.main import create_app

    app = create_app(Settings(db_path=":memory:"))
    with TestClient(app):
        assert app.state.telegram_bot is None


def test_app_starts_and_stops_the_bot_when_configured(monkeypatch):
    from app import main as main_module

    started = threading.Event()

    class DummyBot:
        def __init__(self, client, db, loop, allowed):
            self.allowed = allowed

        async def run_forever(self):
            started.set()
            await asyncio.sleep(3600)

    monkeypatch.setattr(main_module, "TelegramBot", DummyBot)
    monkeypatch.setattr(main_module, "TelegramClient", lambda token: object())
    monkeypatch.setattr(
        main_module.ProviderRegistry,
        "from_settings",
        classmethod(lambda cls, s: _FakeRegistry()),
    )
    settings = Settings(
        db_path=":memory:",
        model="test-model",
        telegram=TelegramSettings(bot_token="token", allowed_chat_ids=[123]),
    )
    app = main_module.create_app(settings)
    with TestClient(app):
        assert started.wait(timeout=2)
        assert isinstance(app.state.telegram_bot, DummyBot)
    assert app.state.telegram_bot is not None


# -- scheduler notifications ----------------------------------------------


async def test_send_notification_chunks_at_the_utf16_limit():
    sent: list[tuple[int, str]] = []
    text = "😀" * (MAX_MESSAGE_LENGTH // 2 + 10)

    await send_notification(
        lambda chat_id, chunk: sent.append((chat_id, chunk)), [7], text
    )

    assert len(sent) == 2
    assert all(
        len(chunk.encode("utf-16-le")) // 2 <= MAX_MESSAGE_LENGTH for _, chunk in sent
    )
    assert "".join(chunk for _, chunk in sent) == text
    assert {chat_id for chat_id, _ in sent} == {7}


async def test_send_notification_keeps_going_after_a_chat_fails():
    sent: list[tuple[int, str]] = []

    def send(chat_id: int, text: str) -> None:
        if chat_id == 1:
            raise RuntimeError("bot was blocked")
        sent.append((chat_id, text))

    with pytest.raises(RuntimeError, match="chat 1"):
        await send_notification(send, [1, 2, 3], "hello")

    assert sent == [(2, "hello"), (3, "hello")]


async def test_telegram_notify_wiring_chunks_and_isolates_chats(monkeypatch):
    from app import main as main_module

    class FakeClient:
        def __init__(self) -> None:
            self.sent: list[tuple[int, str]] = []

        def send_message(self, chat_id: int, text: str) -> None:
            if chat_id == 2:
                raise RuntimeError("bot was blocked by the user")
            self.sent.append((chat_id, text))

        async def aclose(self) -> None:
            pass

    client = FakeClient()
    monkeypatch.setattr(main_module, "TelegramClient", lambda token: client)
    settings = Settings(
        telegram=TelegramSettings(bot_token="token", allowed_chat_ids=[1, 2, 3])
    )
    app = SimpleNamespace(state=SimpleNamespace(settings=settings))
    handler = main_module._telegram_notify(app)
    assert handler is not None
    assert app.state.job_notify_client is client

    text = "x" * (MAX_MESSAGE_LENGTH + 10)
    with pytest.raises(RuntimeError, match="chat 2"):
        await handler(text)

    for chat_id in (1, 3):
        chunks = [chunk for chat, chunk in client.sent if chat == chat_id]
        assert "".join(chunks) == text
        assert len(chunks) == 2
    assert all(chat != 2 for chat, _ in client.sent)
