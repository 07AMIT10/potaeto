"""Tests for 75% context summary rollup and resilient memory indexer."""

import pytest
from app.agent.context import ContextBuilder
from app.db.repositories.messages import MessageRepo
from app.memory.indexer import MemoryIndexer
from app.memory.service import MemoryService


def test_context_rollup_when_exceeding_threshold():
    builder = ContextBuilder(max_context_tokens=1000)
    # Generate 50 messages (~35 tokens each -> ~1750 tokens > 750 tokens threshold)
    # Recent 10 messages: ~350 tokens, well within the 750 token limit.
    messages = [
        {
            "role": "user" if i % 2 == 0 else "assistant",
            "content": f"Message turn {i} with conversation padding text to reach target tokens "
            + "padding " * 12,
        }
        for i in range(50)
    ]

    assembled = builder.build_context(
        messages=messages,
        memories=[],
        system_prompt="System instructions",
    )

    # Must contain summary rollup header and retain last 10 messages
    assert any("[Summary of earlier conversation:" in m["content"] for m in assembled)
    assert len(assembled) <= 15

    # Total token count must be within the 75% threshold (750 tokens)
    total_tokens = sum(len(m["content"]) for m in assembled) // 4
    assert total_tokens <= 750


def test_context_rollup_preserves_last_10_messages_verbatim():
    builder = ContextBuilder(max_context_tokens=1000)
    messages = [
        {
            "role": "user" if i % 2 == 0 else "assistant",
            "content": f"Verbatim turn {i} with text " + "detail " * 10,
        }
        for i in range(40)
    ]

    assembled = builder.build_context(
        messages=messages,
        memories=[],
        system_prompt="Instructions",
    )

    last_10_input = messages[-10:]
    last_10_assembled = assembled[-10:]

    assert len(last_10_assembled) == 10
    for original, preserved in zip(last_10_input, last_10_assembled, strict=True):
        assert preserved["role"] == original["role"]
        assert preserved["content"] == original["content"]
        assert preserved.content == original["content"]
        assert preserved == original


def test_context_rollup_not_activated_under_threshold():
    builder = ContextBuilder(max_context_tokens=2000)
    messages = [
        {"role": "user", "content": "Hello there"},
        {"role": "assistant", "content": "General Kenobi!"},
    ]

    assembled = builder.build_context(
        messages=messages,
        memories=[],
        system_prompt="System instructions",
    )

    assert not any("[Summary of earlier conversation:" in m["content"] for m in assembled)
    assert len(assembled) == 3
    assert assembled[0]["content"] == "System instructions"
    assert assembled[1]["content"] == "Hello there"
    assert assembled[2]["content"] == "General Kenobi!"


def test_context_rollup_with_db_messages(db):
    repo = MessageRepo(db)
    conv = repo.ensure_conversation("u1", "e1")
    # Add 25 messages of ~150 chars each (~37 tokens -> ~925 tokens)
    for i in range(25):
        repo.append(
            conv.id,
            "u1",
            "user" if i % 2 == 0 else "assistant",
            f"Database turn {i}: " + "detail-padding " * 15,
            "app",
        )

    builder = ContextBuilder(db, max_context_tokens=1000)
    ctx = builder.build("u1", "e1", conv.id, "Final user turn")

    # Summary marker should be present
    assert any("[Summary of earlier conversation:" in m.content for m in ctx)
    # The final turn and recent messages are at the tail
    assert ctx[-1].content == "Final user turn"
    assert sum(len(m.content) for m in ctx) // 4 <= 1000


def test_indexer_handles_non_utf8_gracefully(db, tmp_path):
    root = tmp_path / "agent-memory"
    node_dir = root / "facts"
    node_dir.mkdir(parents=True)

    # Write a file containing invalid UTF-8 bytes
    broken_bytes = (
        b"---\nid: broken-utf8-node\ntitle: Broken UTF8 Title\n"
        b"type: fact\nproject: potaeto\n---\n"
        b"Some valid text followed by invalid bytes \x80\xff\xfe\xfa and more text."
    )
    (node_dir / "broken.md").write_bytes(broken_bytes)

    indexer = MemoryIndexer(db)
    # Reindexing should not raise UnicodeDecodeError
    changed = indexer.reindex(root)
    assert changed == 1

    svc = MemoryService(db)
    mem = svc.recall("broken-utf8-node")
    assert mem is not None
    assert "Broken UTF8 Title" in mem.content
    assert "\ufffd" in mem.content


def test_indexer_tombstones_deleted_files(db, tmp_path):
    root = tmp_path / "agent-memory"
    facts_dir = root / "facts"
    facts_dir.mkdir(parents=True)

    # Write 2 node files
    file1 = facts_dir / "fact1.md"
    file1.write_text(
        "---\nid: fact-1\ntitle: First Fact\ntype: fact\nproject: potaeto\n---\nBody of fact 1",
        encoding="utf-8",
    )
    file2 = facts_dir / "fact2.md"
    file2.write_text(
        "---\nid: fact-2\ntitle: Second Fact\ntype: fact\nproject: potaeto\n---\nBody of fact 2",
        encoding="utf-8",
    )

    indexer = MemoryIndexer(db)
    assert indexer.reindex(root) == 2

    svc = MemoryService(db)
    assert svc.recall("fact-1").status == "active"
    assert svc.recall("fact-2").status == "active"
    assert len(svc.search("u_local", "Fact", scope="project:potaeto")) == 2

    # Now delete fact2.md from disk
    file2.unlink()

    # Reindex: should record tombstone / mark inactive for fact-2
    changes = indexer.reindex(root)
    assert changes == 1

    # fact-2 should now be soft-deleted / tombstoned
    mem2 = indexer.repo.get("fact-2", include_deleted=True)
    assert mem2 is not None
    assert mem2.deleted == 1
    assert mem2.status == "inactive"
    assert indexer.repo.get("fact-2") is None

    # Search should no longer return fact-2
    assert len(indexer.repo.search("Second")) == 0
    svc_results = svc.search("u_local", "Second", scope="project:potaeto")
    assert not any(m.id == "fact-2" for m in svc_results)

    # Recall should raise LookupError for tombstoned fact
    with pytest.raises(LookupError):
        svc.recall("fact-2")

    # fact-1 must remain active
    mem1 = svc.recall("fact-1")
    assert mem1.deleted == 0
    assert mem1.status == "active"

    # Next reindex without changes should return 0
    assert indexer.reindex(root) == 0

    # Re-creating fact-2 on disk should resurrect it
    file2.write_text(
        "---\nid: fact-2\ntitle: Second Fact\ntype: fact\nproject: potaeto\n---\nResurrected body 2",
        encoding="utf-8",
    )
    assert indexer.reindex(root) == 1
    resurrected = svc.recall("fact-2")
    assert resurrected.deleted == 0
    assert resurrected.status == "active"
    assert "Resurrected body 2" in resurrected.content
