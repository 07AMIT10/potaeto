# pii-scan: allow-private-ip-file (SSRF fixtures use RFC1918/link-local literals)
"""Tests for the Lens MCP tool client, SSRF enforcement, and tool handlers."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from app.security.ssrf import is_safe_url
from app.tools.lens_mcp import (
    LensMcpClient,
    LensMcpError,
    LensResearchTools,
    LensSidecarUnavailableError,
    get_default_lens_client,
    lens_fetch,
    lens_research,
    lens_verify,
    resolve_lens_binary_path,
    set_default_lens_client,
)
from app.tools.registry import ApprovalRequiredError, ToolRegistry


MOCK_SERVER_CODE = """
import sys
import json

while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        req = json.loads(line)
    except Exception:
        continue

    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params", {})

    if method == "initialize":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "lens-mcp-mock", "version": "0.1.0"},
            },
        }
        sys.stdout.write(json.dumps(resp) + "\\n")
        sys.stdout.flush()
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {"name": "search_literature", "description": "Search papers"},
                    {"name": "fetch_source", "description": "Fetch content"},
                    {"name": "verify_claim", "description": "Verify claims"},
                ]
            },
        }
        sys.stdout.write(json.dumps(resp) + "\\n")
        sys.stdout.flush()
    elif method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments", {})
        if tool_name == "search_literature":
            resp_data = {
                "papers": [
                    {
                        "id": "mock_p1",
                        "title": f"Study on {args.get('query')}",
                        "doi": "10.1234/test",
                    }
                ],
                "count": 1,
            }
            is_err = False
        elif tool_name == "fetch_source":
            resp_data = {
                "url": args.get("url"),
                "content": f"Full paper content for {args.get('url')}",
                "credibility": 0.95,
            }
            is_err = False
        elif tool_name == "verify_claim":
            resp_data = {
                "claim": args.get("claim"),
                "verdict": "supports",
                "credibility": 0.88,
                "sources_count": 1,
            }
            is_err = False
        else:
            resp_data = {"error": f"Unknown tool: {tool_name}"}
            is_err = True

        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(resp_data)}],
                "isError": is_err,
            },
        }
        sys.stdout.write(json.dumps(resp) + "\\n")
        sys.stdout.flush()
"""


@pytest.fixture
def mock_server_path(tmp_path: Path) -> Path:
    """Create a temporary Python script acting as a mock lens-mcp server."""
    script = tmp_path / "mock_lens_mcp.py"
    script.write_text(MOCK_SERVER_CODE, encoding="utf-8")
    return script


@pytest.fixture
async def mock_client(mock_server_path: Path):
    """Yield an initialized LensMcpClient pointing to the mock server."""
    client = LensMcpClient(
        binary_path=[sys.executable, str(mock_server_path)],
        timeout=5.0,
    )
    yield client
    await client.close()


# -- Protocol & Invocations ----------------------------------------------------


async def test_lens_mcp_handshake_and_tools_list(mock_client: LensMcpClient):
    """Test JSON-RPC initialize, notifications/initialized, and tools/list."""
    assert not mock_client.is_running
    await mock_client.ensure_started()
    assert mock_client.is_running
    assert mock_client.server_info.get("name") == "lens-mcp-mock"

    tools = mock_client.available_tools
    tool_names = [t["name"] for t in tools]
    assert "search_literature" in tool_names
    assert "fetch_source" in tool_names
    assert "verify_claim" in tool_names


async def test_search_literature_invocation(mock_client: LensMcpClient):
    """Test search_literature returns parsed structured dictionary."""
    result = await mock_client.search_literature(query="quantum error correction", limit=3)
    assert isinstance(result, dict)
    assert "papers" in result
    assert result["papers"][0]["title"] == "Study on quantum error correction"


async def test_fetch_source_invocation(mock_client: LensMcpClient):
    """Test fetch_source with an academic identifier succeeds and parses output."""
    result = await mock_client.fetch_source("arxiv:2301.00001")
    assert isinstance(result, dict)
    assert result.get("url") == "arxiv:2301.00001"
    assert "Full paper content" in result.get("content", "")


async def test_verify_claim_invocation(mock_client: LensMcpClient):
    """Test verify_claim produces a verdict dictionary."""
    result = await mock_client.verify_claim("Water boils at 100 degrees Celsius")
    assert isinstance(result, dict)
    assert result.get("verdict") == "supports"
    assert result.get("claim") == "Water boils at 100 degrees Celsius"


# -- SSRF Containment on fetch_source ------------------------------------------


@pytest.mark.parametrize(
    "blocked_url",
    [
        "http://127.0.0.1:8000/internal",
        "http://10.0.0.1/admin",
        "http://172.16.0.5/api",
        "http://192.168.1.100/",
        "http://169.254.169.254/latest/meta-data",
        "http://localhost:3000/secret",
        "http://0.0.0.0:8080/",
        "file:///etc/passwd",
        "ftp://private.corp/data",
        "gopher://evil.com/",
    ],
)
async def test_fetch_source_blocks_private_targets(mock_client: LensMcpClient, blocked_url: str):
    """Ensure SSRF-violating URLs are blocked before reaching the MCP subprocess."""
    result = await mock_client.fetch_source(blocked_url)
    assert isinstance(result, dict)
    assert "error" in result
    assert "blocked" in result["error"].lower() or "ssrf" in result["error"].lower()
    assert result.get("fallback", {}).get("blocked") is True


async def test_fetch_source_allows_academic_identifiers(mock_client: LensMcpClient):
    """Ensure non-HTTP academic prefixes bypass arbitrary web fetch checks."""
    for valid_id in ["arxiv:2106.09685", "pubmed:31000000", "PMID:123456", "10.1038/nature12345", "doi:10.1000/182"]:
        res = await mock_client.fetch_source(valid_id)
        assert isinstance(res, dict)
        assert res.get("url") == valid_id


async def test_is_safe_url_predicate():
    """Verify is_safe_url helper correctly identifies safe vs unsafe destinations."""
    assert is_safe_url("http://127.0.0.1") is False
    assert is_safe_url("http://localhost:8080") is False
    assert is_safe_url("file:///etc/hosts") is False
    assert is_safe_url("ftp://example.com") is False
    assert is_safe_url("https://93.184.216.34/") is True


# -- Graceful Error Handling & Fallbacks ---------------------------------------


async def test_missing_binary_returns_structured_fallback():
    """Verify missing sidecar binary degrades gracefully without raising."""
    client = LensMcpClient(binary_path="/nonexistent/lens-mcp/path")

    search_res = await client.search_literature("photosynthesis")
    assert isinstance(search_res, dict)
    assert search_res.get("error") == "Lens MCP sidecar unavailable"
    assert "fallback" in search_res
    assert search_res["fallback"]["query"] == "photosynthesis"

    fetch_res = await client.fetch_source("arxiv:1234.5678")
    assert isinstance(fetch_res, dict)
    assert fetch_res.get("error") == "Lens MCP sidecar unavailable"
    assert fetch_res.get("fallback", {}).get("url") == "arxiv:1234.5678"

    verify_res = await client.verify_claim("DNA is double stranded")
    assert isinstance(verify_res, dict)
    assert verify_res.get("error") == "Lens MCP sidecar unavailable"
    assert verify_res["fallback"]["verdict"] == "unverified"


async def test_crashing_process_returns_structured_fallback():
    """Verify a process that crashes on start is handled cleanly."""
    client = LensMcpClient(
        binary_path=[sys.executable, "-c", "import sys; sys.exit(1)"],
        timeout=2.0,
    )
    result = await client.search_literature("test")
    assert isinstance(result, dict)
    assert result.get("error") == "Lens MCP sidecar unavailable"
    await client.close()


async def test_empty_arguments_validation(mock_client: LensMcpClient):
    """Empty query, url, or claim should return immediate error without RPC call."""
    assert "error" in await mock_client.search_literature("")
    assert "error" in await mock_client.fetch_source("   ")
    assert "error" in await mock_client.verify_claim("")


async def test_reconnect_on_crash(tmp_path: Path):
    """Test that the client reconnects/respawns when sidecar terminates."""
    crash_script = tmp_path / "crash_server.py"
    # Script that handles initialize and 1st search, then terminates
    crash_script.write_text(
        """
import sys, json
line = sys.stdin.readline()
sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":json.loads(line)["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"test"}}}) + "\\n")
sys.stdout.flush()
line = sys.stdin.readline() # notifications/initialized
line = sys.stdin.readline() # tools/list
sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":json.loads(line)["id"],"result":{"tools":[]}}) + "\\n")
sys.stdout.flush()
line = sys.stdin.readline() # tool call
req = json.loads(line)
sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":{"content":[{"type":"text","text":json.dumps({"msg":"first_call"})}],"isError":False}}) + "\\n")
sys.stdout.flush()
sys.exit(0) # Crash/exit
""",
        encoding="utf-8",
    )

    client = LensMcpClient(
        binary_path=[sys.executable, str(crash_script)],
        timeout=3.0,
    )
    # First call succeeds
    res1 = await client.search_literature("query 1")
    assert isinstance(res1, dict)
    assert res1.get("msg") == "first_call"

    # Second call detects exit and respawns a new process
    res2 = await client.search_literature("query 2")
    assert isinstance(res2, dict)
    assert res2.get("msg") == "first_call"

    await client.close()


# -- LensResearchTools & ToolRegistry Integration -----------------------------


async def test_lens_research_tools_wrapper(mock_client: LensMcpClient):
    """Test LensResearchTools exposing as_tool_map and registry integration."""
    tools = LensResearchTools(client=mock_client)
    tool_map = tools.as_tool_map()

    assert "lens_research" in tool_map
    assert "lens_fetch" in tool_map
    assert "lens_verify" in tool_map

    # Execute directly via map
    res = await tool_map["lens_research"](query="deep learning")
    assert isinstance(res, dict)
    assert "papers" in res


async def test_tool_registry_registration_and_execution(mock_client: LensMcpClient):
    """Test registering tools into ToolRegistry and calling execute_async."""
    registry = ToolRegistry()
    tools = LensResearchTools(client=mock_client)
    tools.register_tools(registry)

    assert "lens_research" in registry
    assert "lens_fetch" in registry
    assert "lens_verify" in registry

    res = await registry.execute_async("lens_research", {"query": "CRISPR", "limit": 2})
    assert isinstance(res, dict)
    assert res["papers"][0]["title"] == "Study on CRISPR"


async def test_tool_registry_convenience_register(mock_client: LensMcpClient):
    """Test registry.register_lens_tools method."""
    registry = ToolRegistry()
    tools = LensResearchTools(client=mock_client)
    registry.register_lens_tools(tools)

    assert "lens_verify" in registry
    res = await registry.execute_async("lens_verify", {"claim": "Transformers use self-attention"})
    assert isinstance(res, dict)
    assert res.get("verdict") == "supports"


async def test_module_level_helpers(mock_client: LensMcpClient):
    """Test get_default_lens_client and module-level lens_* functions."""
    old_client = get_default_lens_client()
    try:
        set_default_lens_client(mock_client)
        assert get_default_lens_client() is mock_client

        res = await lens_research(query="neural networks")
        assert isinstance(res, dict)
        assert "papers" in res

        fetch_res = await lens_fetch(url="arxiv:2106.00000")
        assert isinstance(fetch_res, dict)
        assert "Full paper content" in fetch_res.get("content", "")

        ver_res = await lens_verify(claim="Test claim")
        assert isinstance(ver_res, dict)
        assert ver_res.get("verdict") == "supports"
    finally:
        set_default_lens_client(old_client)


# -- Real Binary Integration Test (if compiled binary is present) --------------


REAL_BINARY = resolve_lens_binary_path()


@pytest.mark.skipif(
    not REAL_BINARY or not os.path.exists(REAL_BINARY),
    reason="lens-mcp debug binary not built",
)
async def test_real_lens_mcp_binary_integration():
    """Verify communication with the actual compiled Rust lens-mcp binary."""
    client = LensMcpClient(binary_path=REAL_BINARY, timeout=10.0)
    try:
        await client.ensure_started()
        assert client.is_running
        assert client.server_info.get("name") == "lens-mcp"

        # Test fetch_source on arXiv ID
        res = await client.fetch_source("arxiv:2301.00001")
        assert isinstance(res, dict)
        assert res.get("url") == "arxiv:2301.00001"
        assert res.get("source_type") == "paper"
        assert "content" in res or "metadata" in res
    finally:
        await client.close()
