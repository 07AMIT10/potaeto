"""Potaeto Core Lens MCP Tool Client and agent tools.

Communicates with the standalone `lens-mcp` binary over async stdio JSON-RPC 2.0.
Exposes academic literature search (`lens_research`), source fetching (`lens_fetch`),
and empirical claim verification (`lens_verify`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from app.security.ssrf import is_safe_url
from app.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)


def _candidate_lens_paths() -> list[Path]:
    """Find candidate lens-mcp binaries in the workspace tree."""
    candidates: list[Path] = []
    current = Path(__file__).resolve()
    for parent in current.parents:
        lens_dir = parent / "gandharva" / "lens-native"
        if lens_dir.is_dir():
            candidates.append(lens_dir / "target" / "release" / "lens-mcp")
            candidates.append(lens_dir / "target" / "debug" / "lens-mcp")
            break
    return candidates


class LensMcpError(RuntimeError):
    """Raised when an MCP call encounters a JSON-RPC error."""

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code


class LensSidecarUnavailableError(RuntimeError):
    """Raised when the lens-mcp sidecar binary is missing, failed, or crashed."""


def resolve_lens_binary_path(
    configured_path: str | Path | None = None,
) -> str | None:
    """Resolve the executable path to the lens-mcp binary."""
    if configured_path:
        p = Path(configured_path).expanduser()
        if p.exists():
            return str(p)

    env_path = os.environ.get("LENS_MCP_PATH", "").strip()
    if env_path:
        p = Path(env_path).expanduser()
        if p.exists():
            return str(p)

    try:
        from app.config import get_settings

        settings_path = get_settings().lens_mcp_path
        if settings_path:
            p = Path(settings_path).expanduser()
            if p.exists():
                return str(p)
    except Exception:
        pass

    for cand in _candidate_lens_paths():
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)

    which = shutil.which("lens-mcp")
    if which:
        return which

    return None


class LensMcpClient:
    """Async stdio JSON-RPC 2.0 client for the Lens MCP sidecar."""

    def __init__(
        self,
        binary_path: str | Path | Sequence[str] | None = None,
        *,
        cwd: str | Path | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 30.0,
        ssrf_validator: Callable[[str], bool] | None = None,
    ) -> None:
        if binary_path is not None:
            self.binary_path = binary_path
        else:
            self.binary_path = resolve_lens_binary_path()

        self.cwd = cwd
        self.env = env
        self.timeout = timeout
        self.ssrf_validator = ssrf_validator

        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[int | str, asyncio.Future[dict[str, Any]]] = {}
        self._req_id: int = 0
        self._start_lock: asyncio.Lock = asyncio.Lock()
        self._write_lock: asyncio.Lock = asyncio.Lock()
        self._initialized: bool = False
        self._server_info: dict[str, Any] = {}
        self._tools: list[dict[str, Any]] = []

    @property
    def is_running(self) -> bool:
        """Return True if the subprocess is alive and reader loop is running."""
        return (
            self._proc is not None
            and self._proc.returncode is None
            and self._reader_task is not None
            and not self._reader_task.done()
        )

    @property
    def server_info(self) -> dict[str, Any]:
        """Return server info received during initialization."""
        return dict(self._server_info)

    @property
    def available_tools(self) -> list[dict[str, Any]]:
        """Return tools retrieved from tools/list."""
        return list(self._tools)

    async def ensure_started(self) -> None:
        """Ensure the sidecar process is spawned, healthy, and initialized."""
        if self.is_running and self._initialized:
            return

        async with self._start_lock:
            if self.is_running and self._initialized:
                return

            await self._stop_locked()

            if not self.binary_path:
                raise LensSidecarUnavailableError(
                    "Lens MCP binary path not found or configured"
                )

            if isinstance(self.binary_path, (list, tuple)):
                cmd = [str(arg) for arg in self.binary_path]
            else:
                cmd = [str(self.binary_path)]

            # Check existence if a single binary path was provided
            if len(cmd) == 1 and not shutil.which(cmd[0]) and not os.path.exists(cmd[0]):
                raise LensSidecarUnavailableError(
                    f"Lens MCP binary does not exist: {cmd[0]}"
                )

            try:
                self._proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.cwd) if self.cwd else None,
                    env=self.env,
                )
            except (OSError, FileNotFoundError, PermissionError) as exc:
                raise LensSidecarUnavailableError(
                    f"Failed to start Lens MCP process: {exc}"
                ) from exc

            self._reader_task = asyncio.create_task(
                self._reader_loop(), name="lens-mcp-reader"
            )

            try:
                # 1. initialize
                init_resp = await self._send_request(
                    "initialize",
                    {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "potaeto-orchestrator",
                            "version": "0.1.0",
                        },
                    },
                    timeout=self.timeout,
                )
                self._server_info = init_resp.get("serverInfo", {})

                # 2. notifications/initialized
                await self._send_notification("notifications/initialized", {})

                # 3. tools/list
                try:
                    list_resp = await self._send_request(
                        "tools/list",
                        {},
                        timeout=self.timeout,
                    )
                    self._tools = list_resp.get("tools", [])
                except Exception as exc:
                    logger.warning("tools/list failed on Lens MCP startup: %s", exc)

                self._initialized = True
            except Exception as exc:
                await self._stop_locked()
                raise LensSidecarUnavailableError(
                    f"Lens MCP initialization handshake failed: {exc}"
                ) from exc

    async def _reader_loop(self) -> None:
        """Continuously read newline-delimited JSON-RPC messages from stdout."""
        proc = self._proc
        if proc is None or proc.stdout is None:
            return

        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                line_str = line.decode("utf-8", errors="replace").strip()
                if not line_str:
                    continue
                try:
                    msg = json.loads(line_str)
                except json.JSONDecodeError:
                    logger.warning("Lens MCP emitted invalid JSON: %s", line_str[:160])
                    continue

                req_id = msg.get("id")
                if req_id is not None:
                    fut = self._pending.pop(req_id, None)
                    if fut and not fut.done():
                        fut.set_result(msg)
        except (asyncio.CancelledError, GeneratorExit):
            pass
        except Exception as exc:
            logger.warning("Lens MCP reader loop encountered error: %s", exc)
        finally:
            self._initialized = False
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(
                        LensSidecarUnavailableError("Lens MCP process terminated")
                    )
            self._pending.clear()

    async def _send_notification(
        self, method: str, params: dict[str, Any] | None = None
    ) -> None:
        """Send a JSON-RPC notification (no response expected)."""
        if (
            self._proc is None
            or self._proc.stdin is None
            or self._proc.returncode is not None
        ):
            raise LensSidecarUnavailableError("Lens MCP process is not running")

        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }
        raw = json.dumps(payload) + "\n"
        async with self._write_lock:
            try:
                self._proc.stdin.write(raw.encode("utf-8"))
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                raise LensSidecarUnavailableError(
                    f"Failed to write notification to Lens MCP: {exc}"
                ) from exc

    async def _send_request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = 30.0,
    ) -> Any:
        """Send a JSON-RPC request and wait for the response."""
        if (
            self._proc is None
            or self._proc.stdin is None
            or self._proc.returncode is not None
        ):
            raise LensSidecarUnavailableError("Lens MCP process is not running")

        loop = asyncio.get_running_loop()
        self._req_id += 1
        req_id = self._req_id
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[req_id] = fut

        payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params if params is not None else {},
        }
        raw = json.dumps(payload) + "\n"

        async with self._write_lock:
            try:
                self._proc.stdin.write(raw.encode("utf-8"))
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, OSError) as exc:
                self._pending.pop(req_id, None)
                raise LensSidecarUnavailableError(
                    f"Failed to write request to Lens MCP: {exc}"
                ) from exc

        try:
            async with asyncio.timeout(timeout):
                msg = await fut
        except TimeoutError:
            self._pending.pop(req_id, None)
            raise LensSidecarUnavailableError(
                f"Lens MCP call {method!r} (id={req_id}) timed out after {timeout:g}s"
            )

        if "error" in msg and msg["error"]:
            err = msg["error"]
            err_msg = err.get("message", "Unknown error")
            err_code = err.get("code")
            raise LensMcpError(err_msg, code=err_code)

        return msg.get("result", {})

    def _parse_tool_result(self, raw_result: Any) -> dict[str, Any] | str:
        """Parse MCP content format into JSON structure or text string."""
        if not isinstance(raw_result, dict):
            return str(raw_result)

        content = raw_result.get("content")
        is_error = raw_result.get("isError", False)

        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and "text" in first:
                text_content = first["text"]
                try:
                    parsed = json.loads(text_content)
                    if isinstance(parsed, (dict, list)):
                        if is_error and isinstance(parsed, dict) and "error" not in parsed:
                            return {"error": text_content, "detail": parsed}
                        return parsed
                except (json.JSONDecodeError, TypeError):
                    pass
                if is_error:
                    return {"error": text_content}
                return text_content

        if is_error:
            return {
                "error": raw_result.get("error", "Tool execution failed"),
                "raw": raw_result,
            }

        return raw_result

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any] | str:
        """Call a registered tool on the Lens MCP sidecar with auto-reconnect."""
        clean_name = name.removeprefix("lens_")
        for attempt in range(2):
            try:
                await self.ensure_started()
                raw_result = await self._send_request(
                    "tools/call",
                    {"name": clean_name, "arguments": arguments or {}},
                    timeout=timeout,
                )
                return self._parse_tool_result(raw_result)
            except LensSidecarUnavailableError:
                await self.stop()
                if attempt == 1:
                    raise
            except LensMcpError as exc:
                return {"error": exc.message, "code": exc.code}

        return {"error": "Lens MCP call failed after reconnect attempt"}

    def _is_url_allowed(self, url: str) -> bool:
        """Check URL against SSRF policy while permitting academic identifiers."""
        target = url.strip()
        if not target:
            return False

        # Academic identifiers and DOIs handled by Lens MCP without arbitrary HTTP fetching
        if target.startswith(("arxiv:", "pubmed:", "PMID:", "10.", "doi:")):
            return True

        validator = self.ssrf_validator or is_safe_url
        candidate = target if "://" in target else f"http://{target}"
        return validator(candidate)

    async def search_literature(
        self,
        query: str,
        limit: int = 5,
    ) -> dict[str, Any] | str:
        """Search academic literature across OpenAlex, arXiv, and PubMed."""
        q = (query or "").strip()
        if not q:
            return {"error": "Parameter 'query' cannot be empty"}

        try:
            return await self.call_tool(
                "search_literature", {"query": q, "limit": limit}
            )
        except LensSidecarUnavailableError as exc:
            logger.warning(
                "Lens MCP sidecar unavailable for search_literature: %s", exc
            )
            return {
                "error": "Lens MCP sidecar unavailable",
                "fallback": {
                    "query": q,
                    "limit": limit,
                    "papers": [],
                    "count": 0,
                },
            }
        except Exception as exc:
            logger.exception("Unexpected error in search_literature: %s", exc)
            return {
                "error": "Lens MCP sidecar unavailable",
                "fallback": {"query": q, "error": str(exc)},
            }

    async def fetch_source(
        self,
        url: str,
    ) -> dict[str, Any] | str:
        """Fetch academic paper or URL metadata and content with SSRF containment."""
        u = (url or "").strip()
        if not u:
            return {"error": "Parameter 'url' cannot be empty"}

        if not self._is_url_allowed(u):
            return {
                "error": f"URL blocked by SSRF policy: {u}",
                "fallback": {"url": u, "blocked": True},
            }

        try:
            return await self.call_tool("fetch_source", {"url": u})
        except LensSidecarUnavailableError as exc:
            logger.warning("Lens MCP sidecar unavailable for fetch_source: %s", exc)
            return {
                "error": "Lens MCP sidecar unavailable",
                "fallback": {"url": u, "content": None},
            }
        except Exception as exc:
            logger.exception("Unexpected error in fetch_source: %s", exc)
            return {
                "error": "Lens MCP sidecar unavailable",
                "fallback": {"url": u, "error": str(exc)},
            }

    async def verify_claim(
        self,
        claim: str,
    ) -> dict[str, Any] | str:
        """Verify an empirical claim against scientific grounding sources."""
        c = (claim or "").strip()
        if not c:
            return {"error": "Parameter 'claim' cannot be empty"}

        try:
            return await self.call_tool("verify_claim", {"claim": c})
        except LensSidecarUnavailableError as exc:
            logger.warning("Lens MCP sidecar unavailable for verify_claim: %s", exc)
            return {
                "error": "Lens MCP sidecar unavailable",
                "fallback": {
                    "claim": c,
                    "verdict": "unverified",
                    "sources_count": 0,
                    "sources": [],
                },
            }
        except Exception as exc:
            logger.exception("Unexpected error in verify_claim: %s", exc)
            return {
                "error": "Lens MCP sidecar unavailable",
                "fallback": {"claim": c, "error": str(exc)},
            }

    async def stop(self) -> None:
        """Terminate the running process and reset client state."""
        async with self._start_lock:
            await self._stop_locked()

    async def close(self) -> None:
        """Alias for stop()."""
        await self.stop()

    async def _stop_locked(self) -> None:
        """Internal teardown under start lock."""
        self._initialized = False

        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        self._reader_task = None

        if self._proc is not None:
            if self._proc.returncode is None:
                try:
                    if self._proc.stdin and not self._proc.stdin.is_closing():
                        self._proc.stdin.close()
                    self._proc.terminate()
                    try:
                        await asyncio.wait_for(self._proc.wait(), timeout=1.5)
                    except TimeoutError:
                        self._proc.kill()
                        await self._proc.wait()
                except (ProcessLookupError, OSError):
                    pass
            self._proc = None

        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(
                    LensSidecarUnavailableError("Lens MCP client stopped")
                )
        self._pending.clear()


class LensResearchTools:
    """Tool wrapper exposing Lens literature grounding tools to the agent and registry."""

    def __init__(self, client: LensMcpClient | None = None) -> None:
        self.client = client or get_default_lens_client()

    async def lens_research(
        self,
        query: str,
        limit: int = 5,
    ) -> dict[str, Any] | str:
        """Query academic literature across OpenAlex, arXiv, and PubMed."""
        return await self.client.search_literature(query=query, limit=limit)

    async def lens_fetch(
        self,
        url: str,
    ) -> dict[str, Any] | str:
        """Fetch academic paper or web source metadata and content."""
        return await self.client.fetch_source(url=url)

    async def lens_verify(
        self,
        claim: str,
    ) -> dict[str, Any] | str:
        """Verify an empirical claim against scientific grounding sources."""
        return await self.client.verify_claim(claim=claim)

    def as_tool_map(self) -> dict[str, Callable[..., Any]]:
        """Return the agent-facing tool dictionary."""
        return {
            "lens_research": self.lens_research,
            "lens_fetch": self.lens_fetch,
            "lens_verify": self.lens_verify,
        }

    def register_tools(self, registry: ToolRegistry) -> None:
        """Register the Lens research tools with a ToolRegistry."""
        registry.register(
            self.lens_research,
            name="lens_research",
            description="Query academic literature across OpenAlex, arXiv, and PubMed for empirical grounding.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Academic search query keywords or DOI",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of papers to retrieve (default: 5)",
                    },
                },
                "required": ["query"],
            },
        )
        registry.register(
            self.lens_fetch,
            name="lens_fetch",
            description="Fetch paper or URL metadata and content for empirical grounding.",
            parameters={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL, DOI, arXiv ID, or PubMed ID of the source",
                    },
                },
                "required": ["url"],
            },
        )
        registry.register(
            self.lens_verify,
            name="lens_verify",
            description="Verify an empirical claim against scientific grounding sources and academic literature.",
            parameters={
                "type": "object",
                "properties": {
                    "claim": {
                        "type": "string",
                        "description": "Empirical claim statement to verify",
                    },
                },
                "required": ["claim"],
            },
        )


_default_client: LensMcpClient | None = None
_default_tools: LensResearchTools | None = None


def get_default_lens_client() -> LensMcpClient:
    """Return the global default LensMcpClient instance."""
    global _default_client
    if _default_client is None:
        _default_client = LensMcpClient()
    return _default_client


def set_default_lens_client(client: LensMcpClient | None) -> None:
    """Explicitly assign or clear the active LensMcpClient instance."""
    global _default_client, _default_tools
    _default_client = client
    _default_tools = LensResearchTools(client=client) if client else None


def get_default_lens_tools() -> LensResearchTools:
    """Return the global default LensResearchTools instance."""
    global _default_tools
    if _default_tools is None:
        _default_tools = LensResearchTools(client=get_default_lens_client())
    return _default_tools


async def lens_research(query: str, limit: int = 5) -> dict[str, Any] | str:
    """Query academic literature across OpenAlex, arXiv, and PubMed."""
    return await get_default_lens_tools().lens_research(query=query, limit=limit)


async def lens_fetch(url: str) -> dict[str, Any] | str:
    """Fetch academic paper or web source metadata and content."""
    return await get_default_lens_tools().lens_fetch(url=url)


async def lens_verify(claim: str) -> dict[str, Any] | str:
    """Verify an empirical claim against scientific grounding sources."""
    return await get_default_lens_tools().lens_verify(claim=claim)
