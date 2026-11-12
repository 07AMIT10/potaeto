"""Sandboxed command execution using Bubblewrap namespaces."""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any

#: Maximum characters kept from stdout or stderr before truncation.
MAX_OUTPUT_LENGTH = 8192

#: Default timeout for command execution in seconds.
DEFAULT_TIMEOUT_SEC = 30


def run_sandboxed_command(
    command: str,
    sandbox_dir: str,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> dict[str, Any]:
    """Execute a shell command inside an isolated Bubblewrap sandbox.

    Arguments:
        command: Bash command line to execute.
        sandbox_dir: Host directory mounted read-write as /workspace.
        timeout: Execution timeout in seconds.

    Returns:
        Dictionary with exit_code, stdout, stderr, and timed_out status.

    Raises:
        RuntimeError: If bwrap binary is not available.
    """
    bwrap_path = shutil.which("bwrap") or "/usr/bin/bwrap"
    if not os.path.exists(bwrap_path):
        raise RuntimeError("bwrap binary not available on host system")

    os.makedirs(sandbox_dir, exist_ok=True)

    bwrap_cmd = [
        bwrap_path,
        "--unshare-all",  # isolates network, PID, IPC, UTS, mount namespaces
        "--uid",
        "1000",
        "--gid",
        "1000",
        "--new-session",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--ro-bind",
        "/usr",
        "/usr",
    ]

    for p in ["/lib", "/lib64", "/bin"]:
        if os.path.exists(p):
            bwrap_cmd.extend(["--ro-bind", p, p])

    bwrap_cmd.extend(
        [
            "--dir",
            "/workspace",
            "--chdir",
            "/workspace",
            "--bind",
            os.path.abspath(sandbox_dir),
            "/workspace",
            "/bin/bash",
            "-c",
            command,
        ]
    )

    try:
        proc = subprocess.run(
            bwrap_cmd,
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout,
        )
        return {
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[:MAX_OUTPUT_LENGTH],
            "stderr": (proc.stderr or "")[:MAX_OUTPUT_LENGTH],
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        stdout_str = exc.stdout if isinstance(exc.stdout, str) else ""
        return {
            "exit_code": -1,
            "stdout": stdout_str[:MAX_OUTPUT_LENGTH],
            "stderr": f"Command timed out after {timeout} seconds",
            "timed_out": True,
        }


def run_command(
    command: str,
    sandbox_dir: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> dict[str, Any]:
    """Execute command in sandbox defaulting to POTAETO_SANDBOX_DIR."""
    resolved_dir = sandbox_dir or os.environ.get("POTAETO_SANDBOX_DIR", "data/sandbox")
    return run_sandboxed_command(command, sandbox_dir=resolved_dir, timeout=timeout)


run_command.requires_approval = True  # type: ignore[attr-defined]
