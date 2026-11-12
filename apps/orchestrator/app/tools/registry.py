"""Tool registry with cryptographic approval gating."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Callable

from app.db.repositories.approvals import ApprovalRepo


class ApprovalRequiredError(RuntimeError):
    """Raised when a tool invocation requires human approval before executing."""

    def __init__(
        self,
        approval_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> None:
        super().__init__(f"Tool {tool_name!r} requires approval (id: {approval_id})")
        self.approval_id = approval_id
        self.tool_name = tool_name
        self.arguments = arguments


@dataclass
class ToolDefinition:
    """Represents a tool registered in the ToolRegistry."""

    name: str
    description: str = ""
    parameters: dict[str, Any] = field(default_factory=dict)
    handler: Callable[..., Any] | None = None
    requires_approval: bool = False

    @property
    def needs_approval(self) -> bool:
        if self.requires_approval:
            return True
        if self.handler is not None and getattr(self.handler, "requires_approval", False):
            return True
        return False


class ToolRegistry:
    """Central registry of agent tools with approval gating."""

    def __init__(self, approval_repo: ApprovalRepo | None = None) -> None:
        self.approval_repo = approval_repo
        self._tools: dict[str, ToolDefinition] = {}

    def register(
        self,
        tool: ToolDefinition | Callable[..., Any],
        name: str | None = None,
        *,
        description: str | None = None,
        parameters: dict[str, Any] | None = None,
        requires_approval: bool | None = None,
    ) -> None:
        """Register a ToolDefinition or a raw callable."""
        if isinstance(tool, ToolDefinition):
            self._tools[tool.name] = tool
            return

        tool_name = name or getattr(tool, "__name__", "")
        if not tool_name:
            raise ValueError("Tool name must be provided or callable must have __name__")

        desc = description if description is not None else (inspect.getdoc(tool) or "").strip().split("\n")[0]
        req_appr = (
            requires_approval
            if requires_approval is not None
            else bool(getattr(tool, "requires_approval", False))
        )
        self._tools[tool_name] = ToolDefinition(
            name=tool_name,
            description=desc,
            parameters=parameters or {},
            handler=tool,
            requires_approval=req_appr,
        )

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def __contains__(self, name: str) -> bool:
        return name in self._tools

    def __iter__(self):
        return iter(self._tools.values())

    def items(self):
        return self._tools.items()

    def as_tool_map(self) -> dict[str, Callable[..., Any]]:
        """Return name -> handler map for registered tools."""
        return {
            name: tool.handler
            for name, tool in self._tools.items()
            if tool.handler is not None
        }

    @classmethod
    def from_tool_map(
        cls,
        tools: dict[str, Callable[..., Any]],
        approval_repo: ApprovalRepo | None = None,
    ) -> ToolRegistry:
        registry = cls(approval_repo=approval_repo)
        for name, fn in tools.items():
            registry.register(fn, name=name)
        return registry

    def _prepare_call(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        user_id: str | None = None,
        **extra: Any,
    ) -> tuple[Callable[..., Any], dict[str, Any]]:
        tool = self._tools.get(tool_name)
        if tool is None:
            raise KeyError(f"Tool {tool_name!r} not found in registry")

        if tool.needs_approval:
            action_hash = ApprovalRepo.compute_hash(tool_name, arguments)
            if self.approval_repo is not None and not self.approval_repo.is_approved(action_hash):
                req = self.approval_repo.create_request(
                    tool_name,
                    arguments,
                    requested_by=user_id or extra.get("user_id") or "u_local",
                )
                raise ApprovalRequiredError(req["id"], tool_name, arguments)

        if tool.handler is None:
            raise RuntimeError(f"Tool {tool_name!r} has no handler")

        signature = inspect.signature(tool.handler)
        params = signature.parameters
        kwargs = dict(arguments or {})

        context = dict(extra)
        if user_id is not None and "user_id" not in context:
            context["user_id"] = user_id

        for key, value in context.items():
            if key in params and key not in kwargs:
                kwargs[key] = value

        accepts_kwargs = any(
            p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
        )
        if not accepts_kwargs:
            kwargs = {k: v for k, v in kwargs.items() if k in params}

        return tool.handler, kwargs

    def execute(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        user_id: str | None = None,
        **extra: Any,
    ) -> Any:
        """Execute a tool with approval check.

        If the tool requires approval and no unexpired approved record exists,
        an approval request is created in ApprovalRepo (if configured) and
        ApprovalRequiredError is raised.
        """
        handler, kwargs = self._prepare_call(tool_name, arguments, user_id=user_id, **extra)
        return handler(**kwargs)

    async def execute_async(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        user_id: str | None = None,
        **extra: Any,
    ) -> Any:
        """Execute a tool asynchronously, awaiting if the handler returns an awaitable."""
        handler, kwargs = self._prepare_call(tool_name, arguments, user_id=user_id, **extra)
        result = handler(**kwargs)
        if inspect.isawaitable(result):
            return await result
        return result

    def register_lens_tools(self, tools: Any = None) -> None:
        """Register Lens research tools into this registry."""
        if tools is None:
            from app.tools.lens_mcp import LensResearchTools

            tools = LensResearchTools()
        tools.register_tools(self)
