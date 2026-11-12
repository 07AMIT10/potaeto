"""Agent loop, context budget, turn queue, and the chat endpoints."""

import asyncio

import pytest

from app.agent.context import ContextBuilder, compute_context_budget
from app.agent.loop import AgentLoop, TurnQueue
from app.db.repositories.conversations import ConversationRepo
from app.db.repositories.messages import MessageRepo
from app.db.repositories.tool_calls import ToolCallRepo
from app.memory.service import MemoryService
from app.providers.base import ChatMessage, ModelInfo, StreamEvent


class FakeProvider:
    """A scripted provider: plain text for greetings, a memory tool call when the
    user asks what they like, then the final answer after the tool result."""

    name = "fake"

    async def stream_chat(self, request):
        if any(m.role == "tool" for m in request.messages):
            yield StreamEvent.token("I remember: you like OpenCode Go.")
            yield StreamEvent.done("stop")
            return
        last_user = next(
            (m.content for m in reversed(request.messages) if m.role == "user"), ""
        )
        if "like" in last_user:
            yield StreamEvent.tool_call_delta(0, "call_1", "memory_search", '{"query": "like"}')
            yield StreamEvent.done("tool_calls")
        else:
            yield StreamEvent.token("Hi")
            yield StreamEvent.done("stop")


class SlowProvider:
    """Echoes the last user message one token at a time, with a small delay."""

    name = "slow"

    async def stream_chat(self, request):
        last_user = next(
            (m.content for m in reversed(request.messages) if m.role == "user"), ""
        )
        for part in ("reply: ", last_user):
            yield StreamEvent.token(part)
            await asyncio.sleep(0.01)
        yield StreamEvent.done("stop")


class BlockingProvider:
    """Holds the turn open until the test releases it, to exercise concurrency."""

    name = "blocking"

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def stream_chat(self, request):
        self.started.set()
        await self.release.wait()
        yield StreamEvent.token("Hi")
        yield StreamEvent.done("stop")


@pytest.fixture()
def fake_provider():
    return FakeProvider()


@pytest.fixture()
def slow_provider():
    return SlowProvider()


# ── loop ───────────────────────────────────────────────────────────────


async def test_single_turn_streams_and_persists(db, fake_provider):
    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    events = [e async for e in loop.run(conv, "hello", "app")]
    assert [e.type for e in events][-1] == "done"
    assert MessageRepo(db).last(conv).content == "Hi"


async def test_tool_call_loop_executes_and_feeds_result(db, fake_provider):
    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    events = [e async for e in loop.run(conv, "what do I like?", "app")]
    assert any(e.type == "tool_call" for e in events)
    assert any(e.type == "tool_result" for e in events)
    assert events[-1].type == "done"
    assert events[-1].data["message_id"]
    assert MessageRepo(db).last(conv).content == "I remember: you like OpenCode Go."


class CaptureProvider:
    """Records each request and replies with one token."""

    name = "capture"

    def __init__(self) -> None:
        self.requests = []

    async def stream_chat(self, request):
        self.requests.append(request)
        yield StreamEvent.token("ok")
        yield StreamEvent.done("stop")


class UsageProvider:
    """Reports token/cost usage on the terminal stream event."""

    name = "usage"

    async def stream_chat(self, request):
        yield StreamEvent.token("hi")
        yield StreamEvent.done(
            "stop", {"prompt_tokens": 3, "completion_tokens": 4, "cost": 0.01}
        )


class EmptyProvider:
    """Returns ``done`` without any text, like the live 16:08 failure."""

    name = "empty"

    async def stream_chat(self, request):
        yield StreamEvent.done(
            "stop", {"prompt_tokens": 5, "completion_tokens": 0, "cost": 0.02}
        )


class UnknownToolProvider:
    """Requests a tool that is not registered, then answers normally."""

    name = "unknown-tool"

    async def stream_chat(self, request):
        if any(m.role == "tool" for m in request.messages):
            yield StreamEvent.token("recovered")
            yield StreamEvent.done("stop")
            return
        yield StreamEvent.tool_call_delta(0, "call_x", "does_not_exist", "{}")
        yield StreamEvent.done("tool_calls")


class HugeResultProvider:
    """Requests a tool with a very large body, then answers from the result."""

    name = "huge-result"

    def __init__(self) -> None:
        self.requests = []

    async def stream_chat(self, request):
        self.requests.append(request)
        if any(m.role == "tool" for m in request.messages):
            yield StreamEvent.token("summarized")
            yield StreamEvent.done("stop")
            return
        yield StreamEvent.tool_call_delta(0, "call_big", "huge_tool", "{}")
        yield StreamEvent.done("tool_calls")


def test_default_tool_registry_includes_read_only_monitors(db):
    loop = AgentLoop(db, None)
    assert {"system_health", "http_ping"} <= set(loop.tools)


async def test_tools_are_omitted_for_a_non_tool_model(db):
    provider = CaptureProvider()
    loop = AgentLoop(db, provider, model="m", supports_tools=False)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app")]

    request = provider.requests[0]
    assert request.tools is None
    system = request.messages[0].content
    assert "You have tools" not in system
    assert "tool calls are unavailable" in system.lower()


async def test_tools_are_sent_to_a_tool_capable_model(db):
    provider = CaptureProvider()
    loop = AgentLoop(db, provider, model="m", supports_tools=True)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app")]

    names = {
        tool["function"]["name"]
        for tool in provider.requests[0].tools
    }
    assert {"memory_search", "system_health", "http_ping"} <= names


async def test_loop_sends_the_configured_max_tokens(db):
    provider = CaptureProvider()
    loop = AgentLoop(db, provider, model="m", max_tokens=4096)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app")]

    assert provider.requests[0].max_tokens == 4096


async def test_loop_sends_no_cap_when_max_tokens_is_unset(db):
    provider = CaptureProvider()
    loop = AgentLoop(db, provider, model="m")
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app")]

    assert provider.requests[0].max_tokens is None


def test_max_output_tokens_settings_read_from_env(monkeypatch):
    from app.config import Settings, get_settings

    assert Settings().max_output_tokens == 4096

    monkeypatch.setenv("POTAETO_MAX_OUTPUT_TOKENS", "1024")
    get_settings.cache_clear()
    try:
        assert get_settings().max_output_tokens == 1024

        # Non-positive and invalid values fall back to the safe default.
        for raw in ("0", "-5", "not-a-number"):
            monkeypatch.setenv("POTAETO_MAX_OUTPUT_TOKENS", raw)
            get_settings.cache_clear()
            assert get_settings().max_output_tokens == 4096
    finally:
        get_settings.cache_clear()


def test_context_and_memory_scope_settings_defaults():
    from app.config import Settings

    settings = Settings()
    assert settings.memory_scope == "project:Anveshak"
    assert settings.context_ceiling_tokens == 32000
    assert settings.context_floor_tokens == 4000


def test_context_and_memory_scope_settings_read_from_env(monkeypatch):
    from app.config import Settings, get_settings

    monkeypatch.setenv("POTAETO_MEMORY_SCOPE", "global")
    monkeypatch.setenv("POTAETO_CONTEXT_CEILING", "64000")
    monkeypatch.setenv("POTAETO_CONTEXT_FLOOR", "2000")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.memory_scope == "global"
        assert settings.context_ceiling_tokens == 64000
        assert settings.context_floor_tokens == 2000

        # Non-positive or invalid budgets fall back to their safe defaults.
        for raw in ("0", "-5", "not-a-number"):
            monkeypatch.setenv("POTAETO_CONTEXT_CEILING", raw)
            monkeypatch.setenv("POTAETO_CONTEXT_FLOOR", raw)
            get_settings.cache_clear()
            settings = get_settings()
            assert settings.context_ceiling_tokens == 32000
            assert settings.context_floor_tokens == 4000
        assert Settings().memory_scope == "project:Anveshak"
    finally:
        get_settings.cache_clear()


async def test_turn_records_provider_usage(db):
    from app.db.repositories.usage import UsageRepo

    loop = AgentLoop(db, UsageProvider(), model="test-model")
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app")]

    rows = UsageRepo(db).list()
    assert len(rows) == 1
    row = rows[0]
    assert row.provider == "usage"
    assert row.model_id == "test-model"
    assert row.tokens_in == 3
    assert row.tokens_out == 4
    assert row.cost == pytest.approx(0.01)
    assert row.success == 1


async def test_empty_completion_is_guarded_and_persisted(db):
    """An empty provider reply must not store a zero-length assistant row."""
    from app.db.repositories.usage import UsageRepo

    loop = AgentLoop(db, EmptyProvider(), model="empty-model")
    conv = loop.ensure_conversation("u1", "e1")
    events = [e async for e in loop.run(conv, "hello", "app")]

    types = [e.type for e in events]
    assert "error" in types
    error = next(e for e in events if e.type == "error")
    assert error.data["code"] == "empty_response"
    assert types[-1] == "done"

    assistant = MessageRepo(db).last(conv)
    assert assistant.role == "assistant"
    assert assistant.content.strip()
    assert assistant.content == "I couldn't generate a response. Please retry or switch models."

    usage = UsageRepo(db).list()[0]
    assert usage.success == 0
    assert usage.tokens_in == 5
    assert usage.cost == pytest.approx(0.02)


async def test_successful_tool_call_creates_audit_row(db, fake_provider):
    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "what do I like?", "app")]

    calls = ToolCallRepo(db).list()
    assert len(calls) == 1
    call = calls[0]
    assert call.name == "memory_search"
    assert call.status == "succeeded"
    assert call.result_json is not None
    assert call.started_at and call.finished_at
    user = next(m for m in MessageRepo(db).list(conv) if m.role == "user")
    assert call.message_id == user.id


async def test_unknown_tool_creates_failed_audit_row(db):
    loop = AgentLoop(db, UnknownToolProvider())
    conv = loop.ensure_conversation("u1", "e1")
    events = [e async for e in loop.run(conv, "do the thing", "app")]

    assert any(e.type == "tool_result" for e in events)
    calls = ToolCallRepo(db).list()
    assert len(calls) == 1
    assert calls[0].name == "does_not_exist"
    assert calls[0].status == "failed"
    assert calls[0].error_code == "unknown_tool"
    assert calls[0].result_json is not None
    assert MessageRepo(db).last(conv).content == "recovered"


async def test_memory_search_without_scope_uses_the_loop_project_scope(
    db, fake_provider
):
    """A bare ``memory_search`` sees the same project nodes as context."""
    project = MemoryService(db).add(
        "u1", "e1", "fact", "Alex likes project coffee", "user", None, 0.9,
        "project:Anveshak", "normal", True,
    )

    loop = AgentLoop(db, fake_provider, memory_scope="project:Anveshak")
    hits = loop.tools["memory_search"]("u1", "coffee")
    assert [hit["id"] for hit in hits] == [project.id]

    # The historical default stays global-only, so project facts do not leak.
    assert AgentLoop(db, None).tools["memory_search"]("u1", "coffee") == []


async def test_tool_results_are_capped_before_context_and_audit(db):
    """An 8 KB tool body cannot bloat the next request or the audit table."""
    provider = HugeResultProvider()
    loop = AgentLoop(
        db, provider, tools={"huge_tool": lambda: {"body": "x" * 20_000}}
    )
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "show me everything", "app")]

    tool_message = next(
        m for m in provider.requests[1].messages if m.role == "tool"
    )
    assert len(tool_message.content) == 8_000
    assert tool_message.content.endswith("… truncated")

    call = ToolCallRepo(db).list()[0]
    assert call.status == "succeeded"
    assert call.result_json["_truncated"] is True
    assert len(call.result_json["_preview"]) == 8_000
    assert call.result_json["_preview"].endswith("… truncated")


def test_fit_messages_drops_oldest_history_and_keeps_pinned(db):
    loop = AgentLoop(db, None)
    huge_tool = ChatMessage(
        role="tool", content="y" * 3_000, tool_call_id="c1"
    )
    messages = [
        ChatMessage(role="system", content="system prompt"),
        ChatMessage(role="user", content="old question"),
        ChatMessage(role="assistant", content="a" * 2_000),
        ChatMessage(role="user", content="current question"),
        ChatMessage(
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "huge_tool", "arguments": "{}"},
                }
            ],
        ),
        huge_tool,
    ]

    # Too tight even for the tool pair: drop it and all old history, but never
    # the system prompt or the current user message.
    tight = loop._fit_messages(messages, 1_000)
    assert [m.content for m in tight] == ["system prompt", "current question"]

    # Room for the tool pair, not for the 2,000-char old assistant turn.
    fitted = loop._fit_messages(messages, 4_000)
    assert huge_tool in fitted
    tool_index = fitted.index(huge_tool)
    assert fitted[tool_index - 1].tool_calls
    assert "old question" not in [m.content for m in fitted]
    assert sum(len(m.content) for m in fitted) <= 4_000


async def test_cancelled_tool_audit_row_is_finished(db):
    """A client abort mid-tool must not leave the audit row ``running``."""

    def cancelling_tool():
        raise asyncio.CancelledError()

    loop = AgentLoop(db, None, tools={"cancelling_tool": cancelling_tool})
    with pytest.raises(asyncio.CancelledError):
        await loop._execute_tool(
            "cancelling_tool",
            {},
            user_id="u1",
            entity_id="e1",
            conversation_id="c1",
        )

    call = ToolCallRepo(db).list()[0]
    assert call.name == "cancelling_tool"
    assert call.status == "cancelled"
    assert call.error_code == "cancelled"
    assert call.finished_at
    assert call.result_json == {
        "error": "cancelled",
        "message": "tool 'cancelling_tool' was cancelled",
    }


async def test_context_turn_size_is_logged(db, fake_provider, caplog):
    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")

    with caplog.at_level("INFO", logger="app.agent"):
        _ = [e async for e in loop.run(conv, "what do I like?", "app")]

    records = [
        record for record in caplog.records if "context turn" in record.message
    ]
    assert records
    assert all(record.levelno == 20 for record in records)
    assert "chars ~" in records[0].getMessage()


def test_app_logger_is_info_after_create_app(client):
    import logging

    assert logging.getLogger("app").getEffectiveLevel() == logging.INFO


# ── context ────────────────────────────────────────────────────────────


def test_context_respects_budget(db):
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    blob = "x" * 8_000
    for _ in range(20):
        repo.append(conv.id, "u1", "user", blob, "app")

    ctx = ContextBuilder(db).build("u1", "e1", conv.id, "hello")
    assert sum(len(m.content) for m in ctx) <= 8_000 * 4


def test_context_cites_memory_ids(db):
    service = MemoryService(db)
    memory = service.add(
        "u1", "e1", "fact", "Alex likes tea", "user", None, 0.9, "global", "normal", True
    )
    ctx = ContextBuilder(db).build("u1", "e1", "conv-absent", "tea")
    assert memory.id in ctx[0].content


def test_history_skips_empty_assistant_messages(db):
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    repo.append(conv.id, "u1", "user", "first question", "app")
    repo.append(conv.id, "u1", "assistant", "", "app")
    repo.append(conv.id, "u1", "assistant", "   ", "app")
    repo.append(conv.id, "u1", "assistant", "real answer", "app")

    ctx = ContextBuilder(db).build("u1", "e1", conv.id, "next question")
    history = [m for m in ctx if m.role != "system"]
    assert [m.content for m in history] == [
        "first question",
        "real answer",
        "next question",
    ]
    assert all(m.content.strip() for m in history)


def test_context_memory_scope_selects_project_nodes(db):
    service = MemoryService(db)
    global_memory = service.add(
        "u1", "e1", "fact", "Global note about tea", "user", None, 0.9,
        "global", "normal", True,
    )
    project_memory = service.add(
        "u1", "e1", "fact", "Project note about tea", "user", None, 0.9,
        "project:Anveshak", "normal", True,
    )

    global_ctx = ContextBuilder(db).build("u1", "e1", "conv-absent", "tea")
    assert global_memory.id in global_ctx[0].content
    assert project_memory.id not in global_ctx[0].content

    project_ctx = ContextBuilder(db, memory_scope="project:Anveshak").build(
        "u1", "e1", "conv-absent", "tea"
    )
    assert global_memory.id in project_ctx[0].content
    assert project_memory.id in project_ctx[0].content


def test_compute_context_budget_clamps_and_falls_back():
    assert compute_context_budget(None, 4096, 32000, 4000) == 8000
    assert compute_context_budget(0, 4096, 32000, 4000) == 8000
    assert compute_context_budget(20000, 4096, 32000, 4000) == 14880
    assert compute_context_budget(131072, 4096, 32000, 4000) == 32000
    assert compute_context_budget(8192, 4096, 32000, 4000) == 4000
    assert compute_context_budget(20000, None, 32000, 4000) == 18976


def test_context_builder_scales_retrieval_with_budget(db):
    small = ContextBuilder(db, token_budget=4000)
    assert small.max_messages == 10
    assert small.max_memory_nodes == 8

    large = ContextBuilder(db, token_budget=48000)
    assert large.max_messages == 30
    assert large.max_memory_nodes == 16


def test_context_truncates_oversized_prefix(db):
    service = MemoryService(db)
    for index in range(8):
        service.add(
            "u1", "e1", "fact", f"project note {index} " + "x" * 2_000,
            "user", None, 0.9, "project:Anveshak", "normal", True,
        )

    ctx = ContextBuilder(
        db, token_budget=1000, memory_scope="project:Anveshak"
    ).build("u1", "e1", "conv-absent", "project")
    assert sum(len(m.content) for m in ctx) <= 1000 * 4
    assert any("truncated" in m.content for m in ctx)


def test_factory_uses_catalog_context_length_and_settings(db):
    from app.agent.factory import build_agent_loop
    from app.config import Settings
    from app.providers.registry import ProviderChoice

    provider = CaptureProvider()
    choices = [
        ProviderChoice(
            provider,
            ModelInfo(provider="capture", id="m", context_length=128_000),
        )
    ]
    loop = build_agent_loop(db, choices, "m", settings=Settings())
    assert loop.context_budget == 32000
    assert loop.memory_scope == "project:Anveshak"

    # No catalog metadata keeps the historical 8k fallback.
    fallback = build_agent_loop(db, [ProviderChoice(provider)], "m")
    assert fallback.context_budget == 8000


# ── turn queue ─────────────────────────────────────────────────────────


def test_turn_queue_position_tracking():
    queue = TurnQueue()
    assert queue.position("c") == 0
    assert queue.try_acquire("c") is True
    assert queue.position("c") == 1
    assert queue.try_acquire("c") is False  # already reserved
    queue.release("c")
    assert queue.position("c") == 0


async def test_concurrent_turn_is_queued(db, slow_provider):
    loop = AgentLoop(db, slow_provider)
    conv = loop.ensure_conversation("u1", "e1")
    first = loop.run(conv, "one", "app")
    second = loop.run(conv, "two", "app")

    order: list[tuple[str, str]] = []

    async def collect(tag, gen):
        async for event in gen:
            if event.type == "token":
                order.append((tag, event.data["text"]))

    await asyncio.gather(collect("one", first), collect("two", second))

    one_positions = [i for i, (tag, _) in enumerate(order) if tag == "one"]
    two_positions = [i for i, (tag, _) in enumerate(order) if tag == "two"]
    assert one_positions and two_positions
    assert max(one_positions) < min(two_positions)  # no interleaving

    replies = [m.content for m in MessageRepo(db).list(conv) if m.role == "assistant"]
    assert replies == ["reply: one", "reply: two"]


async def test_run_dedupes_user_message_by_client_id(db, fake_provider):
    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app", client_message_id="m_client_1")]
    _ = [e async for e in loop.run(conv, "hello", "app", client_message_id="m_client_1")]

    user_messages = [m for m in MessageRepo(db).list(conv) if m.role == "user"]
    assert [m.id for m in user_messages] == ["m_client_1"]
    assert len(user_messages) == 1


# ── sync change log ────────────────────────────────────────────────────


async def test_chat_turn_is_recorded_in_the_sync_change_log(db, fake_provider):
    """Streamed turns must be visible to `GET /v1/sync`, not just the local DB."""
    from app.db.repositories.sync import SyncRepo

    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app")]

    changes = SyncRepo(db).get_changes(0)
    assert [(c.entity_type, c.operation) for c in changes] == [
        ("message", "insert"),
        ("message", "insert"),
    ]

    messages = MessageRepo(db).list(conv)
    assert [c.entity_id for c in changes] == [m.id for m in messages]
    payloads = [c.payload_json for c in changes]
    assert [payload["role"] for payload in payloads] == ["user", "assistant"]
    assert [payload["content"] for payload in payloads] == ["hello", "Hi"]
    assert [payload["conversation_id"] for payload in payloads] == [conv, conv]


async def test_push_of_a_streamed_message_does_not_double_record(db, fake_provider):
    """The loop records the change; a later outbox push is a duplicate only."""
    from app.db.repositories.sync import PushOperation, SyncRepo

    loop = AgentLoop(db, fake_provider)
    conv = loop.ensure_conversation("u1", "e1")
    _ = [e async for e in loop.run(conv, "hello", "app", client_message_id="m_client_1")]

    repo = SyncRepo(db)
    before = repo.get_changes(0)
    result = repo.push(
        "d1", [PushOperation("k1", "message", "m_client_1", 0, {"content": "hello"})]
    )[0]
    assert result.status == "duplicate"
    assert repo.get_changes(0) == before


# ── endpoints ──────────────────────────────────────────────────────────


def test_get_primary_agent_returns_potaeto(client, paired_device):
    response = client.get(
        "/v1/agent", headers={"Authorization": f"Bearer {paired_device.token}"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "e_potaeto"
    assert body["name"] == "Potaeto"
    assert body["slug"] == "potaeto"


def test_get_primary_conversation_ensures_thread(client, paired_device, api_db):
    from app.db.repositories.conversations import ConversationRepo

    response = client.get(
        "/v1/chat/conversation",
        headers={"Authorization": f"Bearer {paired_device.token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["id"]
    assert body["entity_id"] == "e_potaeto"
    # Idempotent: a second call returns the same conversation id.
    again = client.get(
        "/v1/chat/conversation",
        headers={"Authorization": f"Bearer {paired_device.token}"},
    ).json()
    assert again["id"] == body["id"]
    assert ConversationRepo(api_db).get(body["id"]).entity_id == "e_potaeto"


def test_get_primary_conversation_requires_auth(client):
    assert client.get("/v1/chat/conversation").status_code == 401


def test_chat_stream_requires_auth(client):
    response = client.post(
        "/v1/chat/stream", json={"conversation_id": "c", "message": "hi"}
    )
    assert response.status_code == 401


def test_chat_stream_streams_sse(client, paired_device, api_db):
    from app.providers.registry import ProviderRegistry

    registry = ProviderRegistry()
    registry.register(FakeProvider())
    client.app.state.providers = registry
    client.app.state.model = "test-model"

    conv = ConversationRepo(api_db).ensure_conversation(paired_device.user_id, "e1")
    response = client.post(
        "/v1/chat/stream",
        json={"conversation_id": conv.id, "message": "hello"},
        headers={"Authorization": f"Bearer {paired_device.token}"},
    )
    assert response.status_code == 200
    assert response.headers["x-conversation-id"] == conv.id
    body = response.text
    assert "event: token" in body
    assert "event: done" in body


def test_chat_stream_sends_configured_max_output_tokens(
    client, paired_device, api_db
):
    """The HTTP route forwards ``settings.max_output_tokens`` to the provider."""
    from app.providers.registry import ProviderRegistry

    provider = CaptureProvider()
    registry = ProviderRegistry()
    registry.register(provider)
    client.app.state.providers = registry
    client.app.state.model = "test-model"

    conv = ConversationRepo(api_db).ensure_conversation(paired_device.user_id, "e1")
    response = client.post(
        "/v1/chat/stream",
        json={"conversation_id": conv.id, "message": "hello"},
        headers={"Authorization": f"Bearer {paired_device.token}"},
    )
    assert response.status_code == 200
    assert provider.requests[0].max_tokens == 4096


def test_chat_stream_dedupes_client_message_id(client, paired_device, api_db):
    from app.providers.registry import ProviderRegistry

    registry = ProviderRegistry()
    registry.register(FakeProvider())
    client.app.state.providers = registry
    client.app.state.model = "test-model"

    conv = ConversationRepo(api_db).ensure_conversation(paired_device.user_id, "e1")
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    payload = {
        "conversation_id": conv.id,
        "message": "hello",
        "client_message_id": "m_client_1",
    }

    first = client.post("/v1/chat/stream", json=payload, headers=headers)
    second = client.post("/v1/chat/stream", json=payload, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200

    user_messages = [
        m for m in MessageRepo(api_db).list(conv.id) if m.role == "user"
    ]
    assert [m.id for m in user_messages] == ["m_client_1"]
    assert len(user_messages) == 1


async def test_concurrent_chat_requests_one_queued(client, paired_device, api_db):
    """Two concurrent requests: exactly one streams (200), the other is 409 queued."""
    import httpx

    from app.providers.registry import ProviderRegistry

    provider = BlockingProvider()
    registry = ProviderRegistry()
    registry.register(provider)
    client.app.state.providers = registry
    client.app.state.model = "test-model"

    conv = ConversationRepo(api_db).ensure_conversation(paired_device.user_id, "e1")
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    payload = {"conversation_id": conv.id, "message": "hi"}

    transport = httpx.ASGITransport(app=client.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        # Start the first turn; it blocks inside the provider, holding the slot.
        first = asyncio.create_task(ac.post("/v1/chat/stream", json=payload, headers=headers))
        await asyncio.wait_for(provider.started.wait(), timeout=2)

        second = await ac.post("/v1/chat/stream", json=payload, headers=headers)
        assert second.status_code == 409
        assert second.json() == {"status": "queued", "position": 1}

        provider.release.set()
        first_response = await first
        assert first_response.status_code == 200
        assert "event: done" in first_response.text
