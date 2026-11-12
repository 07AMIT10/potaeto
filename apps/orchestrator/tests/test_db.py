import asyncio

from app.db.connection import connect_db, run_migrations


def test_pragmas(tmp_path):
    conn = connect_db(tmp_path / "test.db")
    assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2  # FULL

def test_migrations_are_idempotent(db):
    run_migrations(db)
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"messages", "sync_changes", "memories", "jobs"} <= tables

def test_message_append_assigns_monotonic_seq(db):
    from app.db.repositories.messages import MessageRepo
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    a = repo.append(conv.id, "u1", "user", "hello", "app", {})
    b = repo.append(conv.id, "u1", "assistant", "hi", "app", {})
    assert b.seq == a.seq + 1
    assert b.rev == 1

def test_fts_triggers_index_messages(db):
    from app.db.repositories.messages import MessageRepo
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    repo.append(conv.id, "u1", "user", "the quick brown fox", "app", {})
    rows = db.execute("SELECT content FROM messages_fts WHERE messages_fts MATCH 'brown'").fetchall()
    assert rows and "brown" in rows[0][0]


async def test_concurrent_writes_from_a_thread_and_the_loop_both_commit(db):
    """The shared connection must never interleave BEGIN/COMMIT across threads."""
    from app.db.repositories.audit import AuditRepo

    def thread_writer(worker: int) -> None:
        repo = AuditRepo(db)
        for index in range(20):
            repo.create("concurrent", subject=f"thread-{worker}-{index}")

    async def loop_writer() -> None:
        repo = AuditRepo(db)
        for index in range(20):
            repo.create("concurrent", subject=f"loop-{index}")

    tasks = [asyncio.to_thread(thread_writer, worker) for worker in range(4)]
    await asyncio.gather(*tasks, loop_writer())

    count = db.execute(
        "SELECT COUNT(*) FROM audit_events WHERE kind = 'concurrent'"
    ).fetchone()[0]
    assert count == 100  # 4 threads x 20 + the event-loop writer's 20


async def test_ensure_conversation_survives_concurrent_first_boot(db):
    """Two devices booting together must get one row, not an IntegrityError."""
    from app.db.repositories.conversations import ConversationRepo

    repo = ConversationRepo(db)
    results = await asyncio.gather(
        *[
            asyncio.to_thread(repo.ensure_conversation, "u1", "e1")
            for _ in range(8)
        ]
    )
    assert len({conversation.id for conversation in results}) == 1
    count = db.execute(
        "SELECT COUNT(*) FROM conversations WHERE user_id = 'u1' AND entity_id = 'e1'"
    ).fetchone()[0]
    assert count == 1
