"""Developer CLI: pairing-code creation without a public endpoint."""

import json

from app.auth.pairing import PairingService
from app.cli import create_pairing_code, main
from app.db.connection import connect_db


def test_create_pairing_code_is_exchangeable(tmp_path):
    db_path = tmp_path / "cli.db"
    code = create_pairing_code(db_path=db_path, user_id="u_local")

    conn = connect_db(db_path)
    try:
        result = PairingService(conn).exchange(code, "cli-test-device")
    finally:
        conn.close()

    assert result.user_id == "u_local"
    assert result.device_id


def test_cli_pair_json_uses_env_db_path(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "cli.db"
    monkeypatch.setenv("POTAETO_DB_PATH", str(db_path))

    assert main(["pair", "--user", "u_local", "--json"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["user_id"] == "u_local"
    assert payload["ttl_sec"] > 0
    assert payload["code"]

    conn = connect_db(db_path)
    try:
        result = PairingService(conn).exchange(payload["code"], "cli-test-device")
    finally:
        conn.close()
    assert result.user_id == "u_local"


def test_cli_rejects_non_positive_ttl(capsys):
    assert main(["pair", "--ttl", "0"]) == 2
    assert "must be positive" in capsys.readouterr().err


def test_cli_index_memory_indexes_the_markdown_tree(tmp_path, capsys):
    from app.memory.service import MemoryService

    root = tmp_path / "agent-memory"
    node = root / "projects" / "potaeto" / "a.md"
    node.parent.mkdir(parents=True)
    node.write_text(
        "---\nid: a\ntitle: Alpha\nproject: potaeto\nsource: user\n---\nbody",
        encoding="utf-8",
    )
    db_path = tmp_path / "cli.db"

    assert main(["index-memory", "--root", str(root), "--db", str(db_path)]) == 0
    assert "1 memory node(s) updated" in capsys.readouterr().out

    conn = connect_db(db_path)
    try:
        assert MemoryService(conn).recall("a").content.endswith("body")
    finally:
        conn.close()
