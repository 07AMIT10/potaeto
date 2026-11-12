"""Tests for the streaming provider interface, catalog, and SSE parser."""

import json

import httpx

from app.providers.base import ChatMessage, ChatRequest, ModelInfo, StreamEvent
from app.providers.opencode_go import OpenCodeGoProvider
from app.providers.openrouter import OpenRouterProvider

OPENCODE_DISCOVERY = "https://opencode.ai/inference/go/v1/models"
OPENCODE_CHAT = "https://opencode.ai/inference/go/openai/v1/chat/completions"
OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"


def _chat_request(model: str = "m", text: str = "hi") -> ChatRequest:
    return ChatRequest(model=model, messages=[ChatMessage(role="user", content=text)])


def _sse(*chunks: str) -> str:
    """Wrap JSON chunks in SSE framing with a trailing [DONE]."""
    return "".join(f"data: {chunk}\n\n" for chunk in chunks) + "data: [DONE]\n\n"


def _opencode_model(
    model_id: str,
    *,
    protocol_key: str = "chat-completions",
    base_url: str = "https://opencode.ai/inference/go/openai/v1",
) -> dict:
    """A model entry in the verified live OpenCode discovery shape."""
    return {
        "id": model_id,
        "name": model_id,
        "api": {protocol_key: {"base_url": base_url}},
        "limit": {"context": 100000, "output": 4096},
        "capabilities": {"tools": {"supported": True}},
        "cost": {"text": {"input": {"price": 0.01}}},
    }


# ── OpenCode Go ───────────────────────────────────────────────────────


async def test_opencode_discovery_is_anonymous(httpx_mock):
    httpx_mock.add_response(
        url=OPENCODE_DISCOVERY,
        json={"data": [_opencode_model("gpt-5-codex")]},
    )
    provider = OpenCodeGoProvider(api_key="oc_sk_test")
    models = await provider.list_models()
    request = httpx_mock.get_requests()[0]
    assert "authorization" not in request.headers
    assert models[0].id == "gpt-5-codex"
    assert models[0].protocol == "openai"


async def test_opencode_inference_sends_session_header(httpx_mock):
    httpx_mock.add_response(
        method="POST",
        url=OPENCODE_CHAT,
        json={"choices": [{"delta": {"content": "hi"}}]},
    )
    provider = OpenCodeGoProvider(api_key="oc_sk_test", session_id="ses_" + "a" * 32)
    events = [e async for e in provider.stream_chat(_chat_request())]
    assert events
    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer oc_sk_test"
    assert request.headers["x-opencode-session"] == "ses_" + "a" * 32


async def test_opencode_401_falls_back_to_anonymous_discovery(httpx_mock):
    httpx_mock.add_response(status_code=401, json={"error": "bad key"})
    httpx_mock.add_response(  # anonymous retry
        json={"data": [_opencode_model("gpt-5-codex")]}
    )
    models = await OpenCodeGoProvider(api_key="bad").list_models()
    assert models
    assert models[0].id == "gpt-5-codex"


async def test_opencode_discovery_falls_through_to_snapshot(httpx_mock):
    httpx_mock.add_response(url=OPENCODE_DISCOVERY, status_code=500)
    httpx_mock.add_response(
        url="https://opencode.ai/inference/v1/models", status_code=500
    )
    httpx_mock.add_response(url="https://models.dev/api.json", status_code=500)
    models = await OpenCodeGoProvider(api_key="k").list_models()
    # Bundled snapshot is empty until a live capture lands; it must not raise.
    assert models == []


async def test_opencode_native_protocol_fallback(httpx_mock):
    # Discovery populates the model -> protocol/base_url map ("messages" native).
    httpx_mock.add_response(
        url=OPENCODE_DISCOVERY,
        json={
            "data": [
                _opencode_model(
                    "m",
                    protocol_key="messages",
                    base_url="https://opencode.ai/inference/go/anthropic/v1",
                )
            ]
        },
    )
    # Chat completions rejects the model; the native endpoint then succeeds.
    httpx_mock.add_response(
        method="POST",
        url=OPENCODE_CHAT,
        status_code=400,
        json={"type": "ModelProtocolUnsupported"},
    )
    native_url = "https://opencode.ai/inference/go/anthropic/v1/messages"
    httpx_mock.add_response(
        method="POST",
        url=native_url,
        json={"content": [{"type": "text", "text": "native reply"}]},
    )
    provider = OpenCodeGoProvider(api_key="oc")
    await provider.list_models()  # populate protocol/base_url map

    events = [e async for e in provider.stream_chat(_chat_request(model="m"))]
    assert [e.text for e in events if e.type == "token"] == ["native reply"]
    assert events[-1].type == "done"
    assert native_url in [r.url for r in httpx_mock.get_requests()]


async def test_opencode_native_fallback_strips_tools_with_a_clear_note(httpx_mock):
    httpx_mock.add_response(
        url=OPENCODE_DISCOVERY,
        json={
            "data": [
                _opencode_model(
                    "m",
                    protocol_key="messages",
                    base_url="https://opencode.ai/inference/go/anthropic/v1",
                )
            ]
        },
    )
    httpx_mock.add_response(
        method="POST",
        url=OPENCODE_CHAT,
        status_code=400,
        json={"type": "ModelProtocolUnsupported"},
    )
    native_url = "https://opencode.ai/inference/go/anthropic/v1/messages"
    httpx_mock.add_response(
        method="POST",
        url=native_url,
        json={"content": [{"type": "text", "text": "native reply"}]},
    )
    provider = OpenCodeGoProvider(api_key="oc")
    await provider.list_models()

    req = ChatRequest(
        model="m",
        messages=[ChatMessage(role="user", content="hi")],
        tools=[{"type": "function", "function": {"name": "f"}}],
    )
    events = [e async for e in provider.stream_chat(req)]
    # A native-only model must still answer (tools are stripped, not fatal).
    assert [e.text for e in events if e.type == "token"] == ["native reply"]
    assert events[-1].type == "done"

    native_request = next(
        r for r in httpx_mock.get_requests() if str(r.url) == native_url
    )
    body = json.loads(native_request.content)
    assert "tools" not in body
    assert "Tool calls are unavailable" in body["system"]


# ── OpenRouter ────────────────────────────────────────────────────────


async def test_openrouter_model_projection(httpx_mock):
    httpx_mock.add_response(
        url=OPENROUTER_MODELS,
        json={
            "data": [
                {"id": "x", "context_length": 8192, "pricing": {"prompt": "0.000001"}}
            ]
        },
    )
    models = await OpenRouterProvider(api_key="k").list_models()
    assert models[0].id == "x"
    assert models[0].context_length == 8192


async def test_openrouter_stream_error_is_reported(httpx_mock):
    # HTTP 200 with {"error": {"message": "upstream failed"}, "finish_reason": "error"}
    httpx_mock.add_response(
        method="POST",
        url=OPENROUTER_CHAT,
        json={"error": {"message": "upstream failed"}, "finish_reason": "error"},
    )
    provider = OpenRouterProvider(api_key="k")
    events = [e async for e in provider.stream_chat(_chat_request())]
    assert any(e.type == "error" for e in events)
    assert not any(e.type == "done" for e in events)


# ── SSE parser (shared) ───────────────────────────────────────────────


async def test_sse_parser_tolerates_comments_and_done(httpx_mock):
    sse = ": OPENROUTER PROCESSING\n\n" + _sse(
        json.dumps({"choices": [{"delta": {"content": "Hel"}}]}),
        json.dumps({"choices": [{"delta": {"content": "lo"}}]}),
    )
    httpx_mock.add_response(method="POST", url=OPENROUTER_CHAT, text=sse)
    provider = OpenRouterProvider(api_key="k")
    events = [e async for e in provider.stream_chat(_chat_request())]
    assert [e.text for e in events if e.type == "token"] == ["Hel", "lo"]
    assert events[-1].type == "done"


async def test_tool_call_deltas_accumulate_by_index(httpx_mock):
    chunk1 = json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "function": {
                                    "name": "memory_search",
                                    "arguments": '{"query": ',
                                },
                            }
                        ]
                    }
                }
            ]
        }
    )
    # Second chunk omits the index to exercise "missing index after first chunk".
    chunk2 = json.dumps(
        {
            "choices": [
                {"delta": {"tool_calls": [{"function": {"arguments": '"OpenCode"'}}]}}
            ]
        }
    )
    httpx_mock.add_response(
        method="POST", url=OPENROUTER_CHAT, text=_sse(chunk1, chunk2)
    )
    provider = OpenRouterProvider(api_key="k")
    events = [e async for e in provider.stream_chat(_chat_request())]
    deltas = [e for e in events if e.type == "tool_call_delta"]
    assert deltas
    final = deltas[-1]
    assert final.index == 0
    assert final.id == "call_1"
    assert final.name == "memory_search"
    assert final.args == '{"query": "OpenCode"'


async def test_done_carries_finish_reason_and_usage(httpx_mock):
    sse = _sse(
        json.dumps({"choices": [{"delta": {"content": "hi"}}]}),
        json.dumps(
            {
                "choices": [{"finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 2},
            }
        ),
    )
    httpx_mock.add_response(method="POST", url=OPENROUTER_CHAT, text=sse)
    provider = OpenRouterProvider(api_key="k")
    events = [e async for e in provider.stream_chat(_chat_request())]
    done = [e for e in events if e.type == "done"]
    assert len(done) == 1
    assert done[0].finish_reason == "stop"
    assert done[0].usage == {"prompt_tokens": 1, "completion_tokens": 2}


async def test_http_error_status_maps_to_error_event(httpx_mock):
    httpx_mock.add_response(
        method="POST",
        url=OPENROUTER_CHAT,
        status_code=400,
        json={"error": {"code": "ModelProtocolUnsupported", "message": "unsupported"}},
    )
    provider = OpenRouterProvider(api_key="k")
    events = [e async for e in provider.stream_chat(_chat_request())]
    assert events[0].type == "error"
    assert events[0].code == "ModelProtocolUnsupported"


async def test_openrouter_serves_stale_on_network_failure(httpx_mock):
    from app.catalog.cache import CatalogCache

    cache = CatalogCache()
    cache.set(
        "openrouter",
        [ModelInfo("openrouter", "x", context_length=8192)],
        ttl_sec=-1,  # already expired
    )
    httpx_mock.add_exception(httpx.ConnectError("offline"))
    provider = OpenRouterProvider(api_key="k", cache=cache)
    models = await provider.list_models()
    assert models[0].id == "x"


# ── catalog cache / normalize / registry ──────────────────────────────


def test_catalog_cache_ttl_and_stale_serving():
    from app.catalog.cache import CatalogCache

    cache = CatalogCache()
    cache.set("p", [ModelInfo("p", "m")], ttl_sec=-1)  # already expired
    assert cache.get("p") is None
    assert cache.get_stale("p")[0].id == "m"  # stale still available

    cache.set("p", [ModelInfo("p", "m2")], ttl_sec=3600)
    assert cache.get("p")[0].id == "m2"

    cache.invalidate("p")
    assert cache.get("p") is None
    assert cache.get_stale("p") is None


def test_catalog_cache_sqlite_persistence(db):
    from app.catalog.cache import CatalogCache

    cache = CatalogCache(db=db)
    cache.set(
        "opencode_go",
        [ModelInfo("opencode_go", "m", context_length=8192)],
        ttl_sec=3600,
        etag='"abc"',
    )

    # A fresh cache over the same DB serves the persisted catalog.
    cache2 = CatalogCache(db=db)
    got = cache2.get("opencode_go")
    assert got is not None and got[0].id == "m"
    assert got[0].context_length == 8192
    assert cache2.get_stale("opencode_go")[0].id == "m"
    assert cache2.get_etag("opencode_go") == '"abc"'


def test_protocol_from_api():
    from app.catalog.normalize import protocol_from_api

    assert protocol_from_api({"chat-completions": {}}) == "openai"
    assert protocol_from_api({"responses": {}}) == "responses"
    assert protocol_from_api({"messages": {}}) == "messages"
    assert protocol_from_api({"generate-content": {}}) == "google"
    assert protocol_from_api({}) == "openai"


def test_opencode_model_projection_live_shape():
    from app.catalog.normalize import opencode_model_to_info

    info = opencode_model_to_info(
        {
            "id": "claude-haiku-5-5",
            "api": {
                "messages": {
                    "base_url": "https://opencode.ai/inference/go/anthropic/v1"
                }
            },
            "limit": {"context": 1000000, "output": 128000},
            "capabilities": {"tools": {"supported": True}},
            "cost": {"text": {"input": {"price": 0.1}}},
        }
    )
    assert info.protocol == "messages"
    assert info.base_url == "https://opencode.ai/inference/go/anthropic/v1"
    assert info.context_length == 1000000
    assert info.max_output_tokens == 128000
    assert info.supports_tools is True

    info2 = opencode_model_to_info(
        {
            "id": "gpt-5-codex",
            "api": {
                "chat-completions": {
                    "base_url": "https://opencode.ai/inference/go/openai/v1"
                }
            },
            "limit": {"context": 100000, "output": 4096},
            "capabilities": {"tools": {"supported": False}},
        }
    )
    assert info2.protocol == "openai"
    assert info2.base_url == "https://opencode.ai/inference/go/openai/v1"
    assert info2.supports_tools is False


def test_normalize_models_dev_flat_shape():
    from app.catalog.normalize import normalize_models_dev

    payload = {
        "opencode-go": {
            "models": {
                "qwen3.7-plus": {
                    "name": "Qwen3.7 Plus",
                    "limit": {"context": 1000000, "output": 65536},
                    "tool_call": True,
                    "cost": {"input": 0.4, "output": 1.6},
                }
            }
        }
    }
    models = normalize_models_dev(payload)
    assert [m.id for m in models] == ["qwen3.7-plus"]
    assert models[0].context_length == 1000000
    assert models[0].max_output_tokens == 65536
    assert models[0].supports_tools is True


class _CatalogProvider:
    """A scripted provider for selection/failover tests."""

    def __init__(self, name: str, ids: list[str], events: list[StreamEvent]) -> None:
        self.name = name
        self._ids = ids
        self._events = events
        self.calls = 0

    async def list_models(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                provider=self.name,
                id=model_id,
                context_length=128000,
                supports_tools=True,
            )
            for model_id in self._ids
        ]

    async def stream_chat(self, request):
        self.calls += 1
        for event in self._events:
            yield event


async def test_registry_select_promotes_the_provider_listing_the_model():
    from app.providers.registry import ProviderRegistry

    first = _CatalogProvider("first", ["other"], [StreamEvent.done("stop")])
    second = _CatalogProvider("second", ["m"], [StreamEvent.done("stop")])
    registry = ProviderRegistry()
    registry.register(first)
    registry.register(second)

    choices = await registry.select("m", preferred="first")
    assert [choice.name for choice in choices] == ["second", "first"]
    assert choices[0].model is not None
    assert choices[0].model.id == "m"


async def test_failover_retries_the_next_provider_before_the_first_token():
    from app.providers.registry import FailoverProvider, ProviderChoice

    broken = _CatalogProvider(
        "broken", ["m"], [StreamEvent.error("http_500", "upstream down")]
    )
    working = _CatalogProvider(
        "working", ["m"], [StreamEvent.token("hello"), StreamEvent.done("stop")]
    )
    provider = FailoverProvider(
        [ProviderChoice(broken), ProviderChoice(working)]
    )

    events = [event async for event in provider.stream_chat(_chat_request(model="m"))]
    assert [event.type for event in events] == ["token", "done"]
    assert broken.calls == 1
    assert working.calls == 1
    assert provider.last_name == "working"


async def test_failover_does_not_switch_after_partial_output():
    from app.providers.registry import FailoverProvider, ProviderChoice

    partial = _CatalogProvider(
        "partial",
        ["m"],
        [StreamEvent.token("half"), StreamEvent.error("network_error", "dropped")],
    )
    other = _CatalogProvider(
        "other", ["m"], [StreamEvent.token("never"), StreamEvent.done("stop")]
    )
    provider = FailoverProvider([ProviderChoice(partial), ProviderChoice(other)])

    events = [event async for event in provider.stream_chat(_chat_request(model="m"))]
    assert [event.type for event in events] == ["token", "error"]
    assert other.calls == 0


async def test_failover_returns_the_last_error_when_every_provider_fails():
    from app.providers.registry import FailoverProvider, ProviderChoice

    providers = [
        _CatalogProvider("a", ["m"], [StreamEvent.error("http_500", "first")]),
        _CatalogProvider("b", ["m"], [StreamEvent.error("http_502", "second")]),
    ]
    provider = FailoverProvider([ProviderChoice(item) for item in providers])

    events = [event async for event in provider.stream_chat(_chat_request(model="m"))]
    assert len(events) == 1
    assert events[0].type == "error"
    assert events[0].code == "http_502"


def test_registry_from_settings():
    from app.config import OpenCodeSettings, OpenRouterSettings, Settings
    from app.providers.registry import ProviderRegistry

    settings = Settings(
        opencode=OpenCodeSettings(api_key="oc"),
        openrouter=OpenRouterSettings(api_key="or"),
    )
    registry = ProviderRegistry.from_settings(settings)
    assert set(registry.names()) == {"opencode_go", "openrouter"}
