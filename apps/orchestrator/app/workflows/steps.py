"""Workflow step definitions for the Proactive Autonomy Engine.

Provides building blocks for composable, sequential workflows:
- ToolStep: executes a registered tool with variable interpolation.
- LlmStep: prompts an active model provider with templated inputs.
- ConditionStep: evaluates safe conditions and branches to then/else step lists.
- NotifyStep: dispatches notifications to Telegram or system channels.
- MemoryAddStep: commits governed memories with provenance into MemoryService.
- NoopStep: harmless no-op for testing and placeholders.
"""

from __future__ import annotations

import ast
import inspect
import logging
import operator
import re
import sqlite3
from typing import Any

logger = logging.getLogger(__name__)

_VAR_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")
_MISSING = object()


def resolve_path(path: str, data: dict[str, Any]) -> Any:
    """Traverse a dot-separated path within a nested dictionary/object."""
    if path in data:
        return data[path]
    parts = path.split(".")
    current: Any = data
    for part in parts:
        if isinstance(current, dict):
            if part in current:
                current = current[part]
            elif part == "output" and "result" in current:
                current = current["result"]
            else:
                return _MISSING
        elif isinstance(current, (list, tuple)):
            if part.isdigit() and 0 <= int(part) < len(current):
                current = current[int(part)]
            else:
                return _MISSING
        elif hasattr(current, part):
            current = getattr(current, part)
        elif isinstance(current, (str, int, float, bool)) and part == "output":
            # Accessing .output on a primitive value returns the primitive value
            pass
        else:
            return _MISSING
    return current


def interpolate_variables(value: Any, data: dict[str, Any]) -> Any:
    """Substitute {{path}} references in strings, dicts, or lists with values from data."""
    if isinstance(value, str):
        full_match = _VAR_PATTERN.fullmatch(value.strip())
        if full_match:
            path = full_match.group(1)
            resolved = resolve_path(path, data)
            return value if resolved is _MISSING else resolved

        def replace(match: re.Match) -> str:
            path = match.group(1)
            resolved = resolve_path(path, data)
            if resolved is _MISSING or resolved is None:
                return ""
            return str(resolved)

        return _VAR_PATTERN.sub(replace, value)
    elif isinstance(value, dict):
        return {k: interpolate_variables(v, data) for k, v in value.items()}
    elif isinstance(value, list):
        return [interpolate_variables(item, data) for item in value]
    return value


_SAFE_OPERATORS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
    ast.Is: operator.is_,
    ast.IsNot: operator.is_not,
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Not: operator.not_,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def safe_eval_ast(node: ast.AST, data: dict[str, Any]) -> Any:
    """Safely evaluate an AST expression using only allowed operations and lookup data."""
    if isinstance(node, ast.Expression):
        return safe_eval_ast(node.body, data)
    elif isinstance(node, ast.Constant):
        return node.value
    elif isinstance(node, ast.Name):
        if node.id in ("True", "true"):
            return True
        if node.id in ("False", "false"):
            return False
        if node.id in ("None", "null"):
            return None
        val = resolve_path(node.id, data)
        return None if val is _MISSING else val
    elif isinstance(node, ast.Attribute):
        parent_val = safe_eval_ast(node.value, data)
        if isinstance(parent_val, dict):
            val = parent_val.get(node.attr)
            if val is None and node.attr == "output" and "result" in parent_val:
                val = parent_val["result"]
            return val
        if isinstance(parent_val, (str, int, float, bool)) and node.attr == "output":
            return parent_val
        return getattr(parent_val, node.attr, None)
    elif isinstance(node, ast.Subscript):
        parent_val = safe_eval_ast(node.value, data)
        slice_val = safe_eval_ast(node.slice, data)
        try:
            return parent_val[slice_val]
        except Exception:
            return None
    elif isinstance(node, ast.Compare):
        left = safe_eval_ast(node.left, data)
        for op_type, comparator in zip(node.ops, node.comparators, strict=False):
            op_fn = _SAFE_OPERATORS.get(type(op_type))
            if op_fn is None:
                raise ValueError(f"Unsupported comparison operator: {type(op_type).__name__}")
            right = safe_eval_ast(comparator, data)
            if not op_fn(left, right):
                return False
            left = right
        return True
    elif isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            for val_node in node.values:
                if not safe_eval_ast(val_node, data):
                    return False
            return True
        elif isinstance(node.op, ast.Or):
            for val_node in node.values:
                if safe_eval_ast(val_node, data):
                    return True
            return False
    elif isinstance(node, ast.UnaryOp):
        op_fn = _SAFE_OPERATORS.get(type(node.op))
        if op_fn is None:
            raise ValueError(f"Unsupported unary operator: {type(node.op).__name__}")
        operand = safe_eval_ast(node.operand, data)
        return op_fn(operand)
    elif isinstance(node, ast.BinOp):
        op_fn = _SAFE_OPERATORS.get(type(node.op))
        if op_fn is None:
            raise ValueError(f"Unsupported binary operator: {type(node.op).__name__}")
        left = safe_eval_ast(node.left, data)
        right = safe_eval_ast(node.right, data)
        return op_fn(left, right)
    elif isinstance(node, ast.List):
        return [safe_eval_ast(elt, data) for elt in node.elts]
    elif isinstance(node, ast.Tuple):
        return tuple(safe_eval_ast(elt, data) for elt in node.elts)
    elif isinstance(node, ast.Dict):
        return {
            safe_eval_ast(k, data): safe_eval_ast(v, data)
            for k, v in zip(node.keys, node.values, strict=False)
        }
    raise ValueError(f"Unsupported expression node: {type(node).__name__}")


def evaluate_condition(condition: Any, data: dict[str, Any]) -> bool:
    """Evaluate a condition expression safely against variables in data."""
    if isinstance(condition, bool):
        return condition
    if callable(condition):
        res = condition(data)
        return bool(res)
    if isinstance(condition, dict):
        key = condition.get("key") or condition.get("left") or condition.get("field")
        op = condition.get("op") or condition.get("operator") or "=="
        val = condition.get("value") or condition.get("right")
        left_val = resolve_path(str(key), data) if isinstance(key, str) else key
        right_val = (
            resolve_path(str(val), data)
            if isinstance(val, str) and val.startswith("{{")
            else val
        )
        return _compare_values(left_val, op, right_val)
    if isinstance(condition, str):
        cond_str = condition.strip()
        if not cond_str:
            return False
        # Normalize {{var}} to var so it parses as a standard AST attribute/name
        normalized = _VAR_PATTERN.sub(r"\1", cond_str)
        try:
            tree = ast.parse(normalized, mode="eval")
            return bool(safe_eval_ast(tree.body, data))
        except Exception as exc:
            logger.debug("AST parsing failed for condition %r: %s", condition, exc)
            return _regex_eval_condition(cond_str, data)
    return bool(condition)


def _compare_values(left: Any, op: str, right: Any) -> bool:
    if op in ("==", "eq", "is"):
        return (
            str(left) == str(right)
            if (isinstance(left, str) or isinstance(right, str)) and type(left) is not type(right)
            else left == right
        )
    elif op in ("!=", "ne", "is not"):
        return not _compare_values(left, "==", right)
    elif op in ("<", "lt"):
        return left < type(left)(right) if left is not None and right is not None else False
    elif op in ("<=", "le"):
        return left <= type(left)(right) if left is not None and right is not None else False
    elif op in (">", "gt"):
        return left > type(left)(right) if left is not None and right is not None else False
    elif op in (">=", "ge"):
        return left >= type(left)(right) if left is not None and right is not None else False
    elif op in ("in",):
        return left in right if right is not None else False
    elif op in ("not in",):
        return left not in right if right is not None else False
    return False


def _regex_eval_condition(cond: str, data: dict[str, Any]) -> bool:
    match = re.match(r"^(.+?)\s*(==|!=|<=|>=|<|>|in|not in)\s*(.+)$", cond)
    if not match:
        val = resolve_path(cond, data)
        return bool(val and val is not _MISSING)
    left_raw, op, right_raw = match.group(1).strip(), match.group(2).strip(), match.group(3).strip()
    left_val = resolve_path(left_raw, data)
    if left_val is _MISSING:
        left_val = left_raw
    if (right_raw.startswith("'") and right_raw.endswith("'")) or (
        right_raw.startswith('"') and right_raw.endswith('"')
    ):
        right_val = right_raw[1:-1]
    elif right_raw.isdigit():
        right_val = int(right_raw)
    elif right_raw in ("True", "true"):
        right_val = True
    elif right_raw in ("False", "false"):
        right_val = False
    elif right_raw in ("None", "null"):
        right_val = None
    else:
        resolved = resolve_path(right_raw, data)
        right_val = right_raw if resolved is _MISSING else resolved
    return _compare_values(left_val, op, right_val)


class WorkflowStep:
    """Base class for all workflow steps."""

    type: str = "unknown"

    def __init__(self, output_key: str | None = None, id: str | None = None, **extra: Any) -> None:
        self.output_key = output_key or id
        self.id = id
        self.extra = extra

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        registry: Any = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
        notifications: list[dict[str, Any]] | None = None,
        tool_executions: list[dict[str, Any]] | None = None,
        audit_events: list[dict[str, Any]] | None = None,
        engine: Any = None,
    ) -> Any:
        raise NotImplementedError


class ToolStep(WorkflowStep):
    """Step that invokes a registered tool with variable-substituted arguments."""

    type: str = "tool"

    def __init__(
        self,
        tool_name: str | None = None,
        arguments: dict[str, Any] | None = None,
        output_key: str | None = None,
        *,
        tool: str | None = None,
        name: str | None = None,
        args: dict[str, Any] | None = None,
        id: str | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(output_key=output_key, id=id, **extra)
        self.tool_name = tool_name or tool or name
        if not self.tool_name:
            raise ValueError("ToolStep requires 'tool' or 'tool_name'")
        self.arguments = arguments if arguments is not None else (args or {})

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        registry: Any = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
        notifications: list[dict[str, Any]] | None = None,
        tool_executions: list[dict[str, Any]] | None = None,
        audit_events: list[dict[str, Any]] | None = None,
        engine: Any = None,
    ) -> Any:
        if registry is None:
            raise RuntimeError("ToolRegistry is required to execute ToolStep")
        data = {**context, **outputs, "outputs": outputs, "context": context}
        resolved_args = interpolate_variables(self.arguments, data)
        user_id = context.get("user_id", "u1")

        result = registry.execute(self.tool_name, resolved_args, user_id=user_id)
        if inspect.isawaitable(result):
            result = await result

        if tool_executions is not None:
            tool_executions.append(
                {
                    "tool": self.tool_name,
                    "arguments": resolved_args,
                    "result": result,
                }
            )
        return result


class LlmStep(WorkflowStep):
    """Step that calls an active model provider with a templated prompt."""

    type: str = "llm"

    def __init__(
        self,
        prompt: str | None = None,
        template: str | None = None,
        model: str | None = None,
        output_key: str | None = None,
        system_prompt: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        *,
        id: str | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(output_key=output_key, id=id, **extra)
        self.prompt = prompt if prompt is not None else (template or "")
        self.model = model
        self.system_prompt = system_prompt
        self.temperature = temperature
        self.max_tokens = max_tokens

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        registry: Any = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
        notifications: list[dict[str, Any]] | None = None,
        tool_executions: list[dict[str, Any]] | None = None,
        audit_events: list[dict[str, Any]] | None = None,
        engine: Any = None,
    ) -> Any:
        if provider is None:
            raise RuntimeError("Model provider is required to execute LlmStep")
        data = {**context, **outputs, "outputs": outputs, "context": context}
        rendered_prompt = interpolate_variables(self.prompt, data)
        rendered_system = (
            interpolate_variables(self.system_prompt, data)
            if self.system_prompt
            else None
        )

        # 1. Provider with generate_text
        if callable(getattr(provider, "generate_text", None)):
            from app.providers.base import TextMessage, TextRequest

            messages = []
            if rendered_system:
                messages.append(TextMessage(role="system", content=str(rendered_system)))
            messages.append(TextMessage(role="user", content=str(rendered_prompt)))
            req = TextRequest(
                model_key=self.model or getattr(provider, "default_model", "default"),
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
            )
            resp = await provider.generate_text(req)
            return resp.content if hasattr(resp, "content") else str(resp)

        # 2. ChatProvider with stream_chat
        if callable(getattr(provider, "stream_chat", None)):
            from app.providers.base import ChatMessage, ChatRequest

            messages = []
            if rendered_system:
                messages.append(ChatMessage(role="system", content=str(rendered_system)))
            messages.append(ChatMessage(role="user", content=str(rendered_prompt)))
            req = ChatRequest(
                model=self.model or "default",
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
            )
            tokens: list[str] = []
            async for event in provider.stream_chat(req):
                if event.type == "token" and event.text:
                    tokens.append(event.text)
                elif event.type == "error":
                    raise RuntimeError(event.message or "LLM generation error")
            return "".join(tokens)

        # 3. Provider with chat() or callable
        if callable(getattr(provider, "chat", None)):
            res = provider.chat(rendered_prompt)
            if inspect.isawaitable(res):
                res = await res
            return str(res)

        if callable(provider):
            res = provider(rendered_prompt)
            if inspect.isawaitable(res):
                res = await res
            return str(res)

        raise RuntimeError(f"Unsupported provider type: {type(provider)}")


class ConditionStep(WorkflowStep):
    """Step that evaluates safe conditions and branches to then or else steps."""

    type: str = "condition"

    def __init__(
        self,
        condition: Any = None,
        then_steps: list[dict[str, Any] | WorkflowStep] | None = None,
        else_steps: list[dict[str, Any] | WorkflowStep] | None = None,
        output_key: str | None = None,
        *,
        then: list[dict[str, Any] | WorkflowStep] | None = None,
        else_: list[dict[str, Any] | WorkflowStep] | None = None,
        expr: Any = None,
        id: str | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(output_key=output_key, id=id, **extra)
        self.condition = condition if condition is not None else (expr or extra.get("if"))
        self.then_steps = then_steps if then_steps is not None else (then or [])
        self.else_steps = else_steps if else_steps is not None else (else_ or extra.get("else") or [])

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        registry: Any = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
        notifications: list[dict[str, Any]] | None = None,
        tool_executions: list[dict[str, Any]] | None = None,
        audit_events: list[dict[str, Any]] | None = None,
        engine: Any = None,
    ) -> Any:
        data = {**context, **outputs, "outputs": outputs, "context": context}
        condition_met = evaluate_condition(self.condition, data)
        target_steps = self.then_steps if condition_met else self.else_steps
        branch_name = "then" if condition_met else "else"

        branch_results = []
        if target_steps:
            for child in target_steps:
                child_step = parse_step(child)
                child_res = await child_step.execute(
                    context=context,
                    outputs=outputs,
                    registry=registry,
                    db_conn=db_conn,
                    provider=provider,
                    telegram_bot=telegram_bot,
                    notifications=notifications,
                    tool_executions=tool_executions,
                    audit_events=audit_events,
                    engine=engine,
                )
                child_key = getattr(child_step, "output_key", None)
                if child_key:
                    outputs[child_key] = child_res
                branch_results.append(child_res)

        return {
            "condition": bool(condition_met),
            "branch": branch_name,
            "result": branch_results,
        }


class NotifyStep(WorkflowStep):
    """Step that dispatches a notification to Telegram or a system chat."""

    type: str = "notify"

    def __init__(
        self,
        text: str | None = None,
        message: str | None = None,
        channel: str = "telegram",
        chat_id: int | str | None = None,
        output_key: str | None = None,
        *,
        id: str | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(output_key=output_key, id=id, **extra)
        self.text = text if text is not None else (message or "")
        self.channel = channel
        self.chat_id = chat_id

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        registry: Any = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
        notifications: list[dict[str, Any]] | None = None,
        tool_executions: list[dict[str, Any]] | None = None,
        audit_events: list[dict[str, Any]] | None = None,
        engine: Any = None,
    ) -> Any:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("notify requires non-empty 'text'")

        data = {**context, **outputs, "outputs": outputs, "context": context}
        rendered_text = str(interpolate_variables(self.text, data))

        sent = False
        if telegram_bot is not None:
            try:
                if callable(telegram_bot):
                    res = telegram_bot(rendered_text)
                    if inspect.isawaitable(res):
                        await res
                    sent = True
                elif hasattr(telegram_bot, "send_message"):
                    target_chat = self.chat_id
                    if target_chat is None:
                        chat_ids = getattr(telegram_bot, "allowed_chat_ids", None) or getattr(
                            telegram_bot, "chat_ids", None
                        )
                        if chat_ids:
                            target_chat = list(chat_ids)[0]
                    if target_chat is not None:
                        res = telegram_bot.send_message(int(target_chat), rendered_text)
                        if inspect.isawaitable(res):
                            await res
                        sent = True
                elif hasattr(telegram_bot, "send_long"):
                    target_chat = self.chat_id
                    if target_chat is None:
                        chat_ids = getattr(telegram_bot, "allowed_chat_ids", None)
                        if chat_ids:
                            target_chat = list(chat_ids)[0]
                    if target_chat is not None:
                        res = telegram_bot.send_long(int(target_chat), rendered_text)
                        if inspect.isawaitable(res):
                            await res
                        sent = True
            except Exception as exc:
                raise RuntimeError(f"notify failed: {exc}") from exc

        if notifications is not None:
            notifications.append(
                {
                    "text": rendered_text,
                    "channel": self.channel,
                    "chat_id": self.chat_id,
                    "sent": sent,
                }
            )

        return {"text": rendered_text, "channel": self.channel, "sent": sent}


class MemoryAddStep(WorkflowStep):
    """Step that stores an active memory with provenance in MemoryService."""

    type: str = "memory_add"

    def __init__(
        self,
        content: str | None = None,
        body: str | None = None,
        text: str | None = None,
        title: str | None = None,
        source: str = "workflow",
        source_ref: str | None = None,
        confidence: float = 0.9,
        scope: str = "global",
        user_id: str = "u1",
        output_key: str | None = None,
        *,
        id: str | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(output_key=output_key, id=id, **extra)
        self.content = content if content is not None else (body or text or "")
        self.title = title
        self.source = source
        self.source_ref = source_ref
        self.confidence = confidence
        self.scope = scope
        self.user_id = user_id

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        registry: Any = None,
        db_conn: sqlite3.Connection | None = None,
        provider: Any = None,
        telegram_bot: Any = None,
        notifications: list[dict[str, Any]] | None = None,
        tool_executions: list[dict[str, Any]] | None = None,
        audit_events: list[dict[str, Any]] | None = None,
        engine: Any = None,
    ) -> Any:
        if not self.content or not str(self.content).strip():
            raise ValueError("memory_add requires non-empty 'content'")
        if db_conn is None:
            raise RuntimeError("Database connection is required for MemoryAddStep")

        data = {**context, **outputs, "outputs": outputs, "context": context}
        rendered_content = str(interpolate_variables(self.content, data))
        rendered_title = (
            str(interpolate_variables(self.title, data)) if self.title else None
        )

        from app.memory.service import MemoryService

        service = MemoryService(db_conn)
        effective_user_id = context.get("user_id") or self.user_id or "u1"
        memory = service.add(
            user_id=effective_user_id,
            content=rendered_content,
            title=rendered_title,
            source=self.source or "workflow",
            source_ref=self.source_ref,
            confidence=self.confidence,
            scope=self.scope or "global",
        )

        if audit_events is not None:
            audit_events.append(
                {
                    "event": "memory_added",
                    "memory_id": memory.id,
                    "user_id": effective_user_id,
                }
            )

        return {
            "id": memory.id,
            "content": memory.content,
            "source": memory.source,
            "confidence": memory.confidence,
            "status": memory.status,
        }


class NoopStep(WorkflowStep):
    """No-op step that completes successfully without side effects."""

    type: str = "noop"

    async def execute(
        self,
        *,
        context: dict[str, Any],
        outputs: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        return {"type": "noop"}


STEP_REGISTRY: dict[str, type[WorkflowStep]] = {
    "tool": ToolStep,
    "llm": LlmStep,
    "condition": ConditionStep,
    "notify": NotifyStep,
    "memory_add": MemoryAddStep,
    "memory": MemoryAddStep,
    "noop": NoopStep,
}


def parse_step(step_data: dict[str, Any] | WorkflowStep) -> WorkflowStep:
    """Parse a step dictionary into a concrete WorkflowStep instance."""
    if isinstance(step_data, WorkflowStep):
        return step_data
    if not isinstance(step_data, dict):
        raise TypeError("Step definition must be a dictionary or WorkflowStep instance")
    kind = step_data.get("type")
    if not kind:
        raise ValueError("Step definition missing 'type' field")
    step_cls = STEP_REGISTRY.get(kind)
    if step_cls is None:
        raise ValueError(f"unknown step type {kind!r}")
    kwargs = {k: v for k, v in step_data.items() if k != "type"}
    return step_cls(**kwargs)
