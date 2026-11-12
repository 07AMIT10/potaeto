"""Tests for sandboxed command runner using bubblewrap."""

from __future__ import annotations

import pytest

from app.tools.run_command import (
    MAX_OUTPUT_LENGTH,
    run_command,
    run_sandboxed_command,
)


def test_run_command_isolated_workspace(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    sandbox_dir.mkdir()

    # 1. Normal command succeeds in workspace
    res = run_sandboxed_command("echo 'hello sandbox'", sandbox_dir=str(sandbox_dir))
    assert res["exit_code"] == 0
    assert "hello sandbox" in res["stdout"]

    # 2. Filesystem isolation: cannot write outside workspace
    res_outside = run_sandboxed_command(
        "touch /etc/hacked.txt", sandbox_dir=str(sandbox_dir)
    )
    assert res_outside["exit_code"] != 0

    # 3. Network isolation: loopback only, external blocked
    res_net = run_sandboxed_command("ping -c 1 1.1.1.1", sandbox_dir=str(sandbox_dir))
    assert res_net["exit_code"] != 0


def test_run_command_file_persistence(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    res = run_sandboxed_command(
        "echo 'persisted content' > test.txt", sandbox_dir=str(sandbox_dir)
    )
    assert res["exit_code"] == 0
    persisted = sandbox_dir / "test.txt"
    assert persisted.exists()
    assert persisted.read_text().strip() == "persisted content"


def test_run_command_filesystem_isolation(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    # Write to /etc fails
    res_etc = run_sandboxed_command(
        "touch /etc/forbidden.txt", sandbox_dir=str(sandbox_dir)
    )
    assert res_etc["exit_code"] != 0

    # Write to /usr fails (read-only)
    res_usr = run_sandboxed_command(
        "touch /usr/forbidden.txt", sandbox_dir=str(sandbox_dir)
    )
    assert res_usr["exit_code"] != 0


def test_run_command_network_isolation(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    # Sockets cannot connect to external addresses due to --unshare-all
    res_socket = run_sandboxed_command(
        "python3 -c \"import socket; s = socket.socket(); s.connect(('1.1.1.1', 80))\"",
        sandbox_dir=str(sandbox_dir),
    )
    assert res_socket["exit_code"] != 0

    # Ping cannot create raw socket or reach external network
    res_ping = run_sandboxed_command(
        "ping -c 1 192.0.2.1", sandbox_dir=str(sandbox_dir)
    )
    assert res_ping["exit_code"] != 0


def test_run_command_timeout(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    res = run_sandboxed_command("sleep 5", sandbox_dir=str(sandbox_dir), timeout=1)
    assert res["exit_code"] == -1
    assert res["timed_out"] is True
    assert "timed out after 1 seconds" in res["stderr"]


def test_run_command_output_truncation(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    res = run_sandboxed_command(
        "python3 -c \"print('A' * 10000)\"", sandbox_dir=str(sandbox_dir)
    )
    assert res["exit_code"] == 0
    assert len(res["stdout"]) == MAX_OUTPUT_LENGTH
    assert res["timed_out"] is False


def test_run_command_stderr_truncation(tmp_path):
    sandbox_dir = tmp_path / "sandbox"
    res = run_sandboxed_command(
        "python3 -c \"import sys; sys.stderr.write('E' * 10000)\"",
        sandbox_dir=str(sandbox_dir),
    )
    assert res["exit_code"] == 0
    assert len(res["stderr"]) == MAX_OUTPUT_LENGTH


def test_run_command_missing_bwrap(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    monkeypatch.setattr(
        "os.path.exists",
        lambda path: "bwrap" not in str(path),
    )
    with pytest.raises(RuntimeError, match="bwrap binary not available"):
        run_sandboxed_command("echo test", sandbox_dir=str(tmp_path))


def test_run_command_default_dir(tmp_path, monkeypatch):
    custom_sandbox = tmp_path / "custom_env_sandbox"
    monkeypatch.setenv("POTAETO_SANDBOX_DIR", str(custom_sandbox))
    res = run_command("echo 'env default' > env.txt")
    assert res["exit_code"] == 0
    assert (custom_sandbox / "env.txt").read_text().strip() == "env default"
    assert getattr(run_command, "requires_approval", False) is True
