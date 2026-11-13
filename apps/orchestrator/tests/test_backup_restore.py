from __future__ import annotations

import gzip
import sqlite3
import subprocess
from pathlib import Path

from app.db.connection import connect_db, run_migrations

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKUP_SCRIPT = PROJECT_ROOT / "scripts" / "backup.sh"
RESTORE_SCRIPT = PROJECT_ROOT / "scripts" / "restore.sh"


def _populate_sample_db(db_path: Path) -> None:
    conn = connect_db(db_path)
    run_migrations(conn)

    # Insert sample rows into core tables using neutral test fixtures
    conn.execute(
        "INSERT INTO users (id, name) VALUES (?, ?)",
        ("usr_test_1", "Test User"),
    )
    conn.execute(
        "INSERT INTO conversations (id, user_id, entity_id, title) VALUES (?, ?, ?, ?)",
        ("conv_test_1", "usr_test_1", "agent_main", "Test Chat"),
    )
    conn.execute(
        """
        INSERT INTO messages (id, seq, conversation_id, user_id, role, content)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("msg_test_1", 1, "conv_test_1", "usr_test_1", "user", "Hello world"),
    )
    conn.execute(
        "INSERT INTO memories (id, user_id, content) VALUES (?, ?, ?)",
        ("mem_test_1", "usr_test_1", "Prefers dark mode"),
    )
    conn.execute(
        """
        INSERT INTO approvals (
            id, action_hash, tool_name, arguments_json, status, expires_at, requested_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "appr_test_1",
            "hash_abc_123",
            "sample_tool",
            "{}",
            "pending",
            9999999999.0,
            "usr_test_1",
            1000000.0,
        ),
    )
    conn.execute(
        "INSERT INTO serial_events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
        ("device_paired", '{"device_id": "dev_test_1"}', 1000000.0),
    )
    conn.commit()
    conn.close()


def test_backup_and_restore_cycle(tmp_path: Path):
    source_db = tmp_path / "source.db"
    backup_dir = tmp_path / "backups"
    restored_db = tmp_path / "restored.db"

    _populate_sample_db(source_db)

    # 1. Run backup script
    backup_res = subprocess.run(
        [
            "bash",
            str(BACKUP_SCRIPT),
            "--db",
            str(source_db),
            "--dest",
            str(backup_dir),
            "--no-memory-git",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert backup_res.returncode == 0

    # Locate generated backup file
    backup_files = list((backup_dir / "daily").glob("potaeto-*.db.gz"))
    assert len(backup_files) >= 1
    backup_file = backup_files[0]

    # 2. Test dry-run: verifies checks pass but does not create destination file
    dry_res = subprocess.run(
        [
            "bash",
            str(RESTORE_SCRIPT),
            "--backup",
            str(backup_file),
            "--dest",
            str(restored_db),
            "--dry-run",
        ],
        capture_output=True,
        text=True,
    )
    assert dry_res.returncode == 0
    assert "dry run successful" in dry_res.stdout
    assert not restored_db.exists()

    # 3. Test live restore
    restore_res = subprocess.run(
        [
            "bash",
            str(RESTORE_SCRIPT),
            "--backup",
            str(backup_file),
            "--dest",
            str(restored_db),
        ],
        capture_output=True,
        text=True,
    )
    assert restore_res.returncode == 0
    assert "restored successfully" in restore_res.stdout
    assert restored_db.exists()

    # 4. Verify integrity and foreign key checks
    restored_conn = sqlite3.connect(restored_db)
    integrity = restored_conn.execute("PRAGMA integrity_check;").fetchone()
    assert integrity[0] == "ok"

    fk_violations = restored_conn.execute("PRAGMA foreign_key_check;").fetchall()
    assert len(fk_violations) == 0

    # 5. Verify row counts and core table data match source
    tables = [
        "users",
        "conversations",
        "messages",
        "memories",
        "approvals",
        "serial_events",
    ]
    source_conn = sqlite3.connect(source_db)
    for table in tables:
        src_count = source_conn.execute(f"SELECT COUNT(*) FROM {table};").fetchone()[0]
        rst_count = restored_conn.execute(f"SELECT COUNT(*) FROM {table};").fetchone()[0]
        assert src_count == rst_count
        assert src_count > 0

    # Verify schema match
    src_tables = set(
        row[0]
        for row in source_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table';"
        ).fetchall()
    )
    rst_tables = set(
        row[0]
        for row in restored_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table';"
        ).fetchall()
    )
    assert src_tables == rst_tables

    source_conn.close()
    restored_conn.close()


def test_restore_replaces_existing_dest_with_backup(tmp_path: Path):
    source_db = tmp_path / "source.db"
    backup_dir = tmp_path / "backups"
    dest_db = tmp_path / "dest.db"

    _populate_sample_db(source_db)

    subprocess.run(
        [
            "bash",
            str(BACKUP_SCRIPT),
            "--db",
            str(source_db),
            "--dest",
            str(backup_dir),
            "--no-memory-git",
        ],
        check=True,
    )
    backup_file = list((backup_dir / "daily").glob("potaeto-*.db.gz"))[0]

    # Initial restore
    subprocess.run(
        [
            "bash",
            str(RESTORE_SCRIPT),
            "--backup",
            str(backup_file),
            "--dest",
            str(dest_db),
        ],
        check=True,
    )
    assert dest_db.exists()

    # Modify dest_db by adding a sentinel row
    dest_conn = sqlite3.connect(dest_db)
    dest_conn.execute(
        "INSERT INTO users (id, name) VALUES (?, ?)",
        ("usr_sentinel", "Sentinel User"),
    )
    dest_conn.commit()
    dest_conn.close()

    # Restore again over existing dest_db
    res = subprocess.run(
        [
            "bash",
            str(RESTORE_SCRIPT),
            "--backup",
            str(backup_file),
            "--dest",
            str(dest_db),
        ],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0

    # Verify .bak file exists and has the sentinel row
    bak_db = dest_db.with_suffix(".db.bak")
    assert bak_db.exists()
    bak_conn = sqlite3.connect(bak_db)
    sentinel = bak_conn.execute(
        "SELECT id FROM users WHERE id = 'usr_sentinel';"
    ).fetchone()
    assert sentinel is not None
    bak_conn.close()

    # Verify destination database was overwritten cleanly (does not contain sentinel)
    fresh_conn = sqlite3.connect(dest_db)
    cleared = fresh_conn.execute(
        "SELECT id FROM users WHERE id = 'usr_sentinel';"
    ).fetchone()
    assert cleared is None
    fresh_conn.close()


def test_restore_validations(tmp_path: Path):
    # 1. Missing --backup argument
    res1 = subprocess.run(["bash", str(RESTORE_SCRIPT)], capture_output=True, text=True)
    assert res1.returncode != 0
    assert "error" in res1.stderr

    # 2. Non-existent backup file
    res2 = subprocess.run(
        [
            "bash",
            str(RESTORE_SCRIPT),
            "--backup",
            str(tmp_path / "nonexistent.db.gz"),
        ],
        capture_output=True,
        text=True,
    )
    assert res2.returncode != 0
    assert "does not exist" in res2.stderr

    # 3. Invalid gzip file
    corrupt_gz = tmp_path / "corrupt.db.gz"
    corrupt_gz.write_bytes(b"not a valid gzip stream")
    res3 = subprocess.run(
        ["bash", str(RESTORE_SCRIPT), "--backup", str(corrupt_gz)],
        capture_output=True,
        text=True,
    )
    assert res3.returncode != 0
    assert "not a valid gzip file" in res3.stderr

    # 4. Backup file missing a core table
    incomplete_db = tmp_path / "incomplete.db"
    conn = sqlite3.connect(incomplete_db)
    conn.execute("CREATE TABLE users (id TEXT PRIMARY KEY);")
    # missing conversations, messages, memories, approvals, serial_events
    conn.commit()
    conn.close()

    incomplete_gz = tmp_path / "incomplete.db.gz"
    with open(incomplete_db, "rb") as f_in, gzip.open(incomplete_gz, "wb") as f_out:
        f_out.write(f_in.read())

    res4 = subprocess.run(
        ["bash", str(RESTORE_SCRIPT), "--backup", str(incomplete_gz), "--dry-run"],
        capture_output=True,
        text=True,
    )
    assert res4.returncode != 0
    assert "missing core table" in res4.stderr
