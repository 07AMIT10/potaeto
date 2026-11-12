"""The bounded agent loop: context → model → tools → repeat → persist.

The loop owns the per-conversation single-flight turn queue, assembles context,
streams the provider, and executes tool calls only once their arguments are
complete. Tools are never executed inside the provider: tool-call deltas are
accumulated here and run against the tool registry after the stream ends, then
the results are fed back for the next provider turn (up to ``MAX_TOOL_TURNS``).

The tool registry is a plain ``name -> callable`` map, so later tasks (monitor,
scheduler) can register tools without changing the loop.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import sqlite3
import time
import typing
from collections.abc import AsyncIterator, Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from app.agent.context import DEFAULT_TOKEN_BUDGET, ContextBuilder
from app.db.repositories.base import transaction
from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.conversations import ConversationRepo
from app.db.repositories.messages import Message, MessageRepo
from app.db.repositories.sync import SyncRepo
from app.db.repositories.tool_calls import ToolCallRepo
from app.db.repositories.usage import UsageRepo, normalize_usage
from app.memory.service import MemoryService
from app.memory.tools import MemoryTools
from app.providers.base import ChatMessage, ChatRequest, StreamEvent
from app.tools.monitor import MonitorTools
from app.tools.registry import ApprovalRequiredError, ToolRegistry

logger = logging.getLogger(__name__)

MAX_TOOL_TURNS = 8
DEFAULT_MODEL = ""
#: Persisted instead of an empty assistant row when the provider returns no text.
EMPTY_RESPONSE_TEXT = "I couldn't generate a response. Please retry or switch models."
#: Tool results are capped before they enter the context or the audit table, so a
#: memory search cannot blow the budget on a single turn.
TOOL_RESULT_CHAR_CAP = 8_000
TRUNCATED_MARKER = "… truncated"


AgentEventType = Literal[
    "token", "tool_call", "tool_result", "done", "error", "approval_required"
]

# Parameters the loop owns and therefore hides from the model. ``user_confirmed``
# is deliberately included: only an authenticated UI/API may confirm a fact, so
# the model must not see the switch at all.
_HIDDEN_PARAMS = frozenset(
    {"user_id", "entity_id", "conversation_id", "user_confirmed"}
)


@dataclass(frozen=True)
class AgentEvent:
    """One streamed event for a chat client (SSE event name + JSON data)."""

    type: AgentEventType
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def token(cls, text: str) -> AgentEvent:
        return cls("token", {"text": text})

    @classmethod
    def tool_call(cls, call_id: str | None, name: str, arguments: dict[str, Any]) -> AgentEvent:
        return cls("tool_call", {"id": call_id, "name": name, "arguments": arguments})

    @classmethod
    def tool_result(cls, call_id: str | None, name: str, result: Any) -> AgentEvent:
        return cls("tool_result", {"id": call_id, "name": name, "result": result})

    @classmethod
    def done(cls, message_id: str) -> AgentEvent:
        return cls("done", {"message_id": message_id})

    @classmethod
    def approval_required(
        cls, approval_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> AgentEvent:
        return cls(
            "approval_required",
            {
                "approval_id": approval_id,
                "tool_name": tool_name,
                "arguments": arguments,
            },
        )

    @classmethod
    def error(cls, code: str, message: str) -> AgentEvent:
        return cls("error", {"code": code, "message": message})


class TurnQueue:
    """Per-conversation single-flight queue shared across HTTP requests.

    ``try_acquire``/``release`` reserve the turn slot atomically (the HTTP 409
    path); ``lock`` serializes the generator execution so direct callers (tests,
    Telegram) cannot interleave either. Reservation is synchronous, so two
    genuinely concurrent handlers see a deterministic first-wins outcome.
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._active: dict[str, int] = {}

    def lock(self, conversation_id: str) -> asyncio.Lock:
        return self._locks.setdefault(conversation_id, asyncio.Lock())

    def try_acquire(self, conversation_id: str) -> bool:
        """Atomically reserve the turn slot; returns False when already active."""
        if self._active.get(conversation_id, 0) > 0:
            return False
        self._active[conversation_id] = 1
        return True

    def release(self, conversation_id: str) -> None:
        self._active.pop(conversation_id, None)

    def position(self, conversation_id: str) -> int:
        """Number of active reservations (0 = idle)."""
        return self._active.get(conversation_id, 0)


def _json_type(annotation: Any) -> str:
    """Map a Python annotation to a JSON-schema type for tool parameters."""
    if annotation is inspect.Parameter.empty or annotation is None:
        return "string"
    origin = typing.get_origin(annotation)
    if origin is typing.Union:
        for member in typing.get_args(annotation):
            if member is type(None):
                continue
            return _json_type(member)
    if origin is list or annotation is list:
        return "array"
    if origin is dict or annotation is dict:
        return "object"
    if annotation is bool:
        return "boolean"
    if annotation is int:
        return "integer"
    if annotation is float:
        return "number"
    return "string"


def _call_with_context(fn: Callable[..., Any], arguments: dict[str, Any], context: dict[str, Any]) -> Any:
    """Invoke a tool, injecting loop-owned parameters the model did not supply."""
    signature = inspect.signature(fn)
    params = signature.parameters
    kwargs = dict(arguments or {})
    for key, value in context.items():
        if key in params and key not in kwargs:
            kwargs[key] = value
    accepts_kwargs = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
    if not accepts_kwargs:
        kwargs = {k: v for k, v in kwargs.items() if k in params}
    return fn(**kwargs)


def _normalize_result(result: Any) -> Any:
    if result is None or isinstance(result, (str, int, float, bool, list, dict)):
        return result
    return repr(result)


def _utc_iso() -> str:
    """Return a UTC ISO-8601 timestamp for tool-audit rows."""
    return datetime.now(UTC).isoformat()


def _truncate_text(text: str, cap: int = TOOL_RESULT_CHAR_CAP) -> str:
    """Cap ``text`` at ``cap`` chars, leaving a visible truncation marker."""
    if len(text) <= cap:
        return text
    keep = max(0, cap - len(TRUNCATED_MARKER))
    return text[:keep] + TRUNCATED_MARKER


def _cap_tool_result(result: Any) -> str:
    """Serialize a tool result to JSON no larger than ``TOOL_RESULT_CHAR_CAP``."""
    return _truncate_text(json.dumps(result, default=str))


def _message_chars(message: ChatMessage) -> int:
    """Approximate the provider-facing size of one chat message."""
    chars = len(message.content or "")
    if message.tool_calls:
        chars += len(json.dumps(message.tool_calls, default=str))
    return chars


def _audit_payload(result: Any) -> dict[str, Any]:
    """Wrap a tool result for ``result_json`` and cap it at a sane size."""
    payload: dict[str, Any]
    if isinstance(result, dict):
        payload = result
    else:
        payload = {"result": result}
    encoded = json.dumps(payload, default=str)
    if len(encoded) <= TOOL_RESULT_CHAR_CAP:
        return payload
    return {
        "_truncated": True,
        "_original_chars": len(encoded),
        "_preview": _truncate_text(encoded),
    }


class AgentLoop:
    """Binds a provider, memory, and a tool registry into one conversation turn."""

    def __init__(
        self,
        db: sqlite3.Connection,
        provider: Any,
        memory: MemoryService | None = None,
        tools: dict[str, Callable[..., Any]] | ToolRegistry | None = None,
        *,
        model: str = DEFAULT_MODEL,
        queue: TurnQueue | None = None,
        supports_tools: bool | None = None,
        max_tokens: int | None = None,
        context_budget: int | None = None,
        memory_scope: str = "global",
        approval_repo: ApprovalRepo | None = None,
    ) -> None:
        self.db = db
        self.provider = provider
        self.memory = memory if memory is not None else MemoryService(db)
        self.approval_repo = (
            approval_repo if approval_repo is not None else ApprovalRepo(db)
        )
        # The scope must be known before the tools are built: a bare
        # ``memory_search`` call must see the same project nodes as context.
        self.memory_scope = memory_scope
        if isinstance(tools, ToolRegistry):
            self.registry = tools
            if self.registry.approval_repo is None:
                self.registry.approval_repo = self.approval_repo
            self.tools = self.registry.as_tool_map()
        else:
            if tools is None:
                # Memory governance plus the read-only host/network monitors. The
                # monitor's blocking HTTP call is moved off the event loop by
                # ``_execute_tool``.
                self.tools = {
                    **MemoryTools(db, default_scope=self.memory_scope).as_tool_map(),
                    **MonitorTools(db).as_tool_map(),
                }
            else:
                self.tools = dict(tools)
            self.registry = ToolRegistry.from_tool_map(
                self.tools, approval_repo=self.approval_repo
            )
        self.model = model
        # A cap must be sent explicitly: OpenRouter interprets a missing
        # ``max_tokens`` as the model maximum and can reject the request.
        self.max_tokens = max_tokens
        self.context_budget = context_budget
        self.queue = queue if queue is not None else TurnQueue()
        # Unknown (None) stays permissive: providers without catalog metadata
        # still receive tools. A catalog that says ``False`` omits them.
        self.tools_enabled = supports_tools is not False
        self.messages = MessageRepo(db)
        self.conversations = ConversationRepo(db)
        self.sync = SyncRepo(db)
        self.usage = UsageRepo(db)
        self.tool_calls = ToolCallRepo(db)

    def ensure_conversation(self, user_id: str, entity_id: str) -> str:
        """Return the shared (user, entity) conversation id, creating it if absent."""
        return self.conversations.ensure_conversation(user_id, entity_id).id

    def queued_position(self, conversation_id: str) -> int:
        """Number of active reservations (0 = idle)."""
        return self.queue.position(conversation_id)

    def try_acquire_turn(self, conversation_id: str) -> bool:
        """Reserve the turn slot atomically; False means a turn is already active."""
        return self.queue.try_acquire(conversation_id)

    def release_turn(self, conversation_id: str) -> None:
        """Release a previously acquired turn slot."""
        self.queue.release(conversation_id)

    async def run(
        self,
        conversation_id: str,
        user_message: str,
        channel: str = "app",
        *,
        client_message_id: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Stream one turn, serialized per conversation via the turn queue.

        ``client_message_id`` (a client-generated ULID) is used as the persisted
        user-message id when supplied, so a retried chat request or a sync push
        of the same message does not create a second row.
        """
        lock = self.queue.lock(conversation_id)
        async with lock:
            async for event in self._run_turn(
                conversation_id, user_message, channel, client_message_id
            ):
                yield event

    async def _run_turn(
        self,
        conversation_id: str,
        user_message: str,
        channel: str,
        client_message_id: str | None,
    ) -> AsyncIterator[AgentEvent]:
        started = time.perf_counter()
        conversation = self.conversations.get(conversation_id)
        if conversation is None:
            yield AgentEvent.error("not_found", f"conversation {conversation_id!r} not found")
            return
        user_id = conversation.user_id
        entity_id = conversation.entity_id

        # 1. Assemble context (history excludes the incoming message).
        context = ContextBuilder(
            self.db,
            token_budget=self.context_budget or DEFAULT_TOKEN_BUDGET,
            memory_scope=self.memory_scope,
        ).build(
            user_id,
            entity_id,
            conversation_id,
            user_message,
            tools_enabled=self.tools_enabled,
        )
        chat_messages = [ChatMessage(role=m.role, content=m.content) for m in context]

        # 2. Persist the user's message (after context is built, before the loop).
        user_message_row = self._persist_user_message(
            conversation_id, user_id, user_message, channel, client_message_id
        )

        # 3. Bounded tool-call loop.
        tool_schemas = self._tool_schemas() if self.tools_enabled else None
        final_text = ""
        # A tool-using turn makes several provider calls; sum their usage.
        usage_totals: dict[str, Any] = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "cost": 0.0,
            "allowance": {},
        }
        for turn in range(MAX_TOOL_TURNS + 1):
            char_budget = self._char_budget()
            assembled = sum(_message_chars(m) for m in chat_messages)
            logger.info(
                "context turn %s: %s chars ~%s tokens (budget %s)",
                turn + 1,
                assembled,
                assembled // 4,
                char_budget,
            )
            if assembled > char_budget:
                logger.warning(
                    "context turn %s exceeds the budget: %s > %s chars",
                    turn + 1,
                    assembled,
                    char_budget,
                )
            request = ChatRequest(
                model=self.model,
                messages=chat_messages,
                tools=tool_schemas,
                max_tokens=self.max_tokens,
            )
            turn_text: list[str] = []
            tool_deltas: dict[int, dict[str, Any]] = {}
            error_event: StreamEvent | None = None

            try:
                async for event in self.provider.stream_chat(request):
                    if event.type == "token":
                        text = event.text or ""
                        turn_text.append(text)
                        yield AgentEvent.token(text)
                    elif event.type == "tool_call_delta":
                        index = event.index if event.index is not None else 0
                        acc = tool_deltas.setdefault(
                            index, {"id": None, "name": None, "args": ""}
                        )
                        if event.id is not None:
                            acc["id"] = event.id
                        if event.name is not None:
                            acc["name"] = event.name
                        if event.args is not None:
                            acc["args"] = event.args  # parser sends the accumulated args
                    elif event.type == "done":
                        if event.usage is not None:
                            tokens_in, tokens_out, cost, allowance = normalize_usage(
                                event.usage
                            )
                            usage_totals["prompt_tokens"] += tokens_in
                            usage_totals["completion_tokens"] += tokens_out
                            usage_totals["cost"] += cost
                            if allowance:
                                usage_totals["allowance"] = allowance
                        break
                    elif event.type == "error":
                        error_event = event
                        break
            except Exception as exc:  # noqa: BLE001 - provider failure is surfaced, not fatal
                yield AgentEvent.error("loop_error", str(exc))
                return

            if error_event is not None:
                yield AgentEvent.error(
                    error_event.code or "provider_error",
                    error_event.message or "provider error",
                )
                return

            tool_calls = self._complete_tool_calls(tool_deltas)

            if tool_calls and turn < MAX_TOOL_TURNS:
                chat_messages.append(self._assistant_tool_message(tool_calls))
                approval_interrupted = False
                for call in tool_calls:
                    yield AgentEvent.tool_call(call["id"], call["name"], call["arguments"])
                    try:
                        result = await self._execute_tool(
                            call["name"],
                            call["arguments"],
                            user_id=user_id,
                            entity_id=entity_id,
                            conversation_id=conversation_id,
                            message_id=user_message_row.id,
                        )
                    except ApprovalRequiredError as exc:
                        yield AgentEvent.approval_required(
                            exc.approval_id, exc.tool_name, exc.arguments
                        )
                        approval_interrupted = True
                        break
                    yield AgentEvent.tool_result(call["id"], call["name"], result)
                    chat_messages.append(
                        ChatMessage(
                            role="tool",
                            content=_cap_tool_result(result),
                            tool_call_id=call["id"],
                        )
                    )
                    # Tool bodies can be large even after the per-result cap;
                    # drop the oldest history/tool turns so the next provider
                    # request still fits the model window.
                    chat_messages = self._fit_messages(
                        chat_messages, self._char_budget()
                    )
                if approval_interrupted:
                    self._record_usage(usage_totals, started, success=True)
                    return
                continue

            final_text = "".join(turn_text)
            break

        # 4. Guard against an empty completion before persisting. The provider
        # can return ``done`` with no tokens or only tool-call deltas (the
        # 2026-11-11 turn stored a zero-length assistant row and 310k tokens in).
        empty_response = not final_text.strip()
        if empty_response:
            logger.warning(
                "provider %s model %s returned an empty completion",
                self._provider_name(),
                self.model or "unknown",
            )
            final_text = EMPTY_RESPONSE_TEXT

        # 5. Persist the assistant message and mark a summary as due.
        message = self._append_with_change(
            conversation_id, user_id, "assistant", final_text, channel
        )
        self._trigger_summary(conversation_id, message.id)

        # 6. Record token/cost usage from the provider's terminal event. This
        # is accounting only: a failure here must not lose a completed turn.
        self._record_usage(usage_totals, started, success=not empty_response)

        if empty_response:
            yield AgentEvent.error(
                "empty_response", "The model returned no text."
            )
        yield AgentEvent.done(message.id)

    def _provider_name(self) -> str:
        """Return the provider that actually served the turn (failover-aware)."""
        return str(
            getattr(self.provider, "last_name", None)
            or getattr(self.provider, "name", "")
            or "unknown"
        )

    def _record_usage(
        self,
        usage: dict[str, Any] | None,
        started: float,
        *,
        success: bool = True,
    ) -> None:
        """Persist provider usage for budget/allowance accounting."""
        tokens_in, tokens_out, cost, allowance = normalize_usage(usage)
        try:
            self.usage.record(
                self._provider_name(),
                self.model or "unknown",
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cost=cost,
                allowance=allowance,
                success=success,
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception:  # noqa: BLE001 - accounting never breaks a turn
            return

    # -- context fitting ------------------------------------------------

    def _char_budget(self) -> int:
        """Provider-facing char budget: the context token budget × 4."""
        return (self.context_budget or DEFAULT_TOKEN_BUDGET) * 4

    def _fit_messages(
        self, chat_messages: list[ChatMessage], char_budget: int
    ) -> list[ChatMessage]:
        """Trim ``chat_messages`` to ``char_budget`` chars, oldest first.

        The system prompt(s) and the current (last) user message are pinned:
        they are never dropped, even when they alone exceed the budget. The
        remaining messages are dropped from the oldest end, keeping an assistant
        tool-call message together with the tool results that answer it so the
        provider never sees an orphaned ``tool`` message.
        """
        if not chat_messages or char_budget <= 0:
            return chat_messages
        sizes = [_message_chars(m) for m in chat_messages]
        total = sum(sizes)
        if total <= char_budget:
            return chat_messages

        last_user = max(
            (i for i, m in enumerate(chat_messages) if m.role == "user"),
            default=None,
        )
        pinned = {i for i, m in enumerate(chat_messages) if m.role == "system"}
        if last_user is not None:
            pinned.add(last_user)

        # Group the droppable messages into atomic units: an assistant
        # tool-call message plus the contiguous tool results it produced.
        units: list[list[int]] = []
        index = 0
        while index < len(chat_messages):
            if index in pinned:
                index += 1
                continue
            message = chat_messages[index]
            unit = [index]
            if message.role == "assistant" and message.tool_calls:
                follow = index + 1
                while (
                    follow < len(chat_messages)
                    and chat_messages[follow].role == "tool"
                    and follow not in pinned
                ):
                    unit.append(follow)
                    follow += 1
            units.append(unit)
            index = unit[-1] + 1

        used = sum(sizes[i] for i in pinned)
        keep = set(pinned)
        # Newest units win; stop at the first one that no longer fits so the
        # surviving history stays contiguous.
        for unit in reversed(units):
            cost = sum(sizes[i] for i in unit)
            if used + cost > char_budget:
                break
            keep.update(unit)
            used += cost

        fitted = [m for i, m in enumerate(chat_messages) if i in keep]
        logger.warning(
            "context trimmed: %s -> %s chars (budget %s, %s message(s) dropped)",
            total,
            used,
            char_budget,
            len(chat_messages) - len(fitted),
        )
        return fitted

    # -- tool execution -------------------------------------------------

    def _complete_tool_calls(self, tool_deltas: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
        """Parse the accumulated per-index tool-call deltas into concrete calls."""
        calls: list[dict[str, Any]] = []
        for index in sorted(tool_deltas):
            delta = tool_deltas[index]
            name = delta.get("name")
            if not name:
                continue
            arguments: Any = {}
            raw = (delta.get("args") or "").strip()
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = {"_raw": raw}
                arguments = parsed if isinstance(parsed, dict) else {"_value": parsed}
            calls.append(
                {
                    "id": delta.get("id") or f"call_{index}",
                    "name": name,
                    "arguments": arguments,
                }
            )
        return calls

    def _assistant_tool_message(self, tool_calls: list[dict[str, Any]]) -> ChatMessage:
        return ChatMessage(
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": json.dumps(call["arguments"], default=str),
                    },
                }
                for call in tool_calls
            ],
        )

    async def _execute_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        user_id: str,
        entity_id: str,
        conversation_id: str,
        message_id: str | None = None,
    ) -> Any:
        audit_id = self._start_tool_audit(name, arguments, message_id)
        # Defaults describe an execution that never returns: if the client
        # disconnects mid-tool the ``finally`` still closes the audit row
        # instead of leaving it ``running`` forever.
        status = "cancelled"
        error_code: str | None = "cancelled"
        result: Any = {"error": "cancelled", "message": f"tool {name!r} was cancelled"}
        try:
            context = {
                "user_id": user_id,
                "entity_id": entity_id,
                "conversation_id": conversation_id,
            }
            if hasattr(self, "registry") and self.registry and name in self.registry:
                try:
                    result = await asyncio.to_thread(
                        self.registry.execute,
                        name,
                        arguments,
                        **context,
                    )
                except ApprovalRequiredError as exc:
                    status = "pending_approval"
                    error_code = "approval_required"
                    if audit_id is not None:
                        try:
                            self.tool_calls.update(
                                audit_id,
                                status="pending_approval",
                                approval_id=exc.approval_id,
                                error_code="approval_required",
                            )
                        except Exception:
                            logger.exception(
                                "failed to record pending approval for %s", audit_id
                            )
                    raise
                except Exception as exc:  # noqa: BLE001 - a tool error is a structured result
                    result = {"error": type(exc).__name__, "message": str(exc)}
                    status, error_code = "failed", type(exc).__name__
                    return result
                status, error_code = "succeeded", None
                return _normalize_result(result)

            fn = self.tools.get(name)
            if fn is None:
                result = {"error": "unknown_tool", "message": f"unknown tool {name!r}"}
                status, error_code = "failed", "unknown_tool"
                return result
            try:
                # Tools are synchronous callables and some (``http_ping``) block
                # on network I/O. Run them in the threadpool so a slow monitor
                # never stalls the SSE stream; the DB write lock serializes
                # memory writes.
                result = await asyncio.to_thread(
                    _call_with_context, fn, arguments, context
                )
            except ApprovalRequiredError as exc:
                status = "pending_approval"
                error_code = "approval_required"
                if audit_id is not None:
                    try:
                        self.tool_calls.update(
                            audit_id,
                            status="pending_approval",
                            approval_id=exc.approval_id,
                            error_code="approval_required",
                        )
                    except Exception:
                        logger.exception(
                            "failed to record pending approval for %s", audit_id
                        )
                raise
            except Exception as exc:  # noqa: BLE001 - a tool error is a structured result
                result = {"error": type(exc).__name__, "message": str(exc)}
                status, error_code = "failed", type(exc).__name__
                return result
            status, error_code = "succeeded", None
            return _normalize_result(result)
        finally:
            self._finish_tool_audit(
                audit_id, status=status, result=result, error_code=error_code
            )

    # -- tool-call audit ------------------------------------------------

    def _start_tool_audit(
        self,
        name: str,
        arguments: dict[str, Any],
        message_id: str | None,
    ) -> str | None:
        """Insert a ``running`` tool_calls row; auditing must not break a turn."""
        try:
            call = self.tool_calls.create(
                name,
                message_id=message_id,
                arguments=arguments,
                status="running",
            )
            self.tool_calls.update(call.id, started_at=_utc_iso())
            return call.id
        except Exception:  # tool audit is best-effort
            logger.exception("failed to record tool call %s", name)
            return None

    def _finish_tool_audit(
        self,
        audit_id: str | None,
        *,
        status: str,
        result: Any,
        error_code: str | None = None,
    ) -> None:
        if audit_id is None:
            return
        if status == "pending_approval":
            return
        try:
            self.tool_calls.finish(
                audit_id,
                status=status,
                result=_audit_payload(result),
                error_code=error_code,
            )
        except Exception:  # tool audit is best-effort
            logger.exception("failed to finish tool call audit %s", audit_id)

    # -- tool schema ----------------------------------------------------

    def _tool_schemas(self) -> list[dict[str, Any]]:
        return [self._tool_schema(name, fn) for name, fn in self.tools.items()]

    def _tool_schema(self, name: str, fn: Callable[..., Any]) -> dict[str, Any]:
        signature = inspect.signature(fn)
        properties: dict[str, Any] = {}
        required: list[str] = []
        for pname, param in signature.parameters.items():
            if pname == "self" or pname in _HIDDEN_PARAMS:
                continue
            properties[pname] = {"type": _json_type(param.annotation), "description": pname}
            if param.default is inspect.Parameter.empty:
                required.append(pname)
        doc = (inspect.getdoc(fn) or "").strip().split("\n")[0]
        return {
            "type": "function",
            "function": {
                "name": name,
                "description": doc,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        }

    # -- persistence ----------------------------------------------------

    def _persist_user_message(
        self,
        conversation_id: str,
        user_id: str,
        content: str,
        channel: str,
        client_message_id: str | None,
    ) -> Message:
        """Persist the incoming user message, idempotently by client id.

        When the client supplied a message id, reuse the existing row if one is
        already present (a retried chat request or a sync push of the same
        message), so the same logical message is never stored twice. Such a row
        already has its change-log entry, so no second one is recorded.
        """
        if client_message_id:
            existing = self.messages.get(client_message_id)
            if existing is not None:
                return existing
        return self._append_with_change(
            conversation_id,
            user_id,
            "user",
            content,
            channel,
            message_id=client_message_id or None,
        )

    def _append_with_change(
        self,
        conversation_id: str,
        user_id: str,
        role: str,
        content: str,
        channel: str,
        *,
        message_id: str | None = None,
    ) -> Message:
        """Append a message and its ``sync_changes`` row in one transaction.

        Chat turns persist directly (there is no client push operation), so the
        change row is written here instead. Without it a streamed turn would
        never appear in ``GET /v1/sync`` and could not reach another device.
        The payload is the message row, matching what ``SyncRepo._push_message``
        records, so ``pull()`` applies both paths identically.
        """
        with self.sync.write_transaction():
            message = self.messages.append(
                conversation_id,
                user_id,
                role,
                content,
                channel,
                message_id=message_id,
            )
            self.sync.record_change("message", message.id, "insert", asdict(message))
        return message

    def _trigger_summary(self, conversation_id: str, message_id: str) -> None:
        """Record that a summary is due without blocking the turn on a model call.

        A later summarizer consumes ``conversation_summaries.last_message_id`` to
        know which messages it still needs to roll up.
        """
        with transaction(self.db):
            self.db.execute(
                """
                INSERT INTO conversation_summaries (
                    conversation_id, summary, last_message_id, updated_at
                ) VALUES (?, '', ?, datetime('now'))
                ON CONFLICT(conversation_id) DO UPDATE SET
                    last_message_id = excluded.last_message_id,
                    updated_at = excluded.updated_at
                """,
                (conversation_id, message_id),
            )
