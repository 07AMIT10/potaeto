"""Governed memory: service, indexer, agent tools, and the seven evaluations.

The seven memory evaluations pinned by the design spec live at the bottom of
this file (``test_eval_*``). The rest of the file covers the service and
indexer contracts the agent loop (Task 8) relies on.
"""

from pathlib import Path

import pytest

from app.db.connection import connect_db, run_migrations
from app.memory.indexer import MemoryIndexer
from app.memory.service import MemoryService
from app.memory.tools import MemoryTools


def _add(svc: MemoryService, content: str = "Alex uses OpenCode Go", **overrides):
    """Add a confirmed user fact with sensible defaults."""
    values = {
        "user_id": "u1",
        "entity_id": "e1",
        "kind": "fact",
        "content": content,
        "source": "user",
        "source_ref": None,
        "confidence": 0.9,
        "scope": "global",
        "sensitivity": "normal",
        "user_confirmed": True,
    }
    values.update(overrides)
    return svc.add(**values)


def _ids(memories) -> set[str]:
    return {memory.id for memory in memories}


# ---------------------------------------------------------------------------
# Service contract (brief)
# ---------------------------------------------------------------------------


def test_add_and_search(db):
    svc = MemoryService(db)
    m = svc.add(
        "u1", "e1", "fact", "Alex uses OpenCode Go", "user", None, 0.9, "global", "normal", True
    )
    assert m.id in [r.id for r in svc.search("u1", "OpenCode")]


def test_retracted_memory_is_not_retrieved(db):
    svc = MemoryService(db)
    m = _add(svc)
    svc.retract(m.id)
    assert m.id not in _ids(svc.search("u1", "OpenCode"))


def test_supersede_hides_old_fact(db):
    svc = MemoryService(db)
    old = _add(svc, "Alex uses Provider A")
    new = _add(svc, "Alex uses Provider B")
    svc.supersede(old.id, new.id)
    assert svc.recall(old.id).status == "superseded"
    assert svc.recall(new.id).supersedes == old.id
    found = _ids(svc.search("u1", "Provider"))
    assert old.id not in found
    assert new.id in found


def test_supersede_cannot_resurrect_a_retracted_memory(db):
    svc = MemoryService(db)
    old = _add(svc, "Alex uses Provider A")
    retired = _add(svc, "Alex uses Provider B")
    svc.retract(retired.id)
    with pytest.raises(ValueError):
        svc.supersede(old.id, retired.id)
    assert svc.recall(old.id).status == "active"
    found = _ids(svc.search("u1", "Provider"))
    assert old.id in found
    assert retired.id not in found


def test_web_fact_is_candidate_not_confirmed(db):
    svc = MemoryService(db)
    m = _add(
        svc,
        "Alex uses Provider A",
        source="web",
        confidence=0.9,
        user_confirmed=False,
    )
    assert m.user_confirmed is False or m.user_confirmed == 0
    assert m.confidence < 0.9


def test_writes_require_a_source(db):
    svc = MemoryService(db)
    with pytest.raises(ValueError):
        _add(svc, source="")
    with pytest.raises(ValueError):
        _add(svc, content="   ")


def test_search_excludes_expired_memories(db):
    svc = MemoryService(db)
    expired = _add(svc, "Alex used Provider C", valid_to="2000-01-01 00:00:00")
    current = _add(svc, "Alex uses Provider D", valid_to="2999-01-01 00:00:00")
    found = _ids(svc.search("u1", "Provider"))
    assert current.id in found
    assert expired.id not in found
    # Recall is an audit read, so expired rows stay reachable by id.
    assert svc.recall(expired.id).status == "active"


def test_recall_missing_memory_raises(db):
    with pytest.raises(LookupError):
        MemoryService(db).recall("mem_missing")


def test_search_uses_or_prefix_tokens_for_natural_questions(db):
    svc = MemoryService(db)
    tea = _add(svc, "Alex likes tea")
    _add(svc, "Potaeto runs on the host")

    # "like" must match "likes" (prefix query) and stopwords must not hide it.
    assert tea.id in _ids(svc.search("u1", "what do I like?"))


def test_search_falls_back_to_recent_memories(db):
    svc = MemoryService(db)
    first = _add(svc, "Alex likes tea")
    second = _add(svc, "Alex lives in Springfield")

    hits = _ids(svc.search("u1", "zzzz-no-match"))
    assert hits == {first.id, second.id}


# ---------------------------------------------------------------------------
# Indexer contract (brief + governance)
# ---------------------------------------------------------------------------


def _write_node(root: Path, project: str, name: str, frontmatter: str, body: str) -> Path:
    path = root / "projects" / project / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{frontmatter}\n---\n{body}", encoding="utf-8")
    return path


def test_indexer_upserts_only_changed_nodes(db, tmp_path):
    root = tmp_path / "agent-memory"
    (root / "projects" / "potaeto").mkdir(parents=True)
    (root / "projects" / "potaeto" / "a.md").write_text("---\nid: a\ntitle: A\n---\nbody")
    idx = MemoryIndexer(db)
    assert idx.reindex(root) == 1
    assert idx.reindex(root) == 0  # unchanged

    (root / "projects" / "potaeto" / "a.md").write_text(
        "---\nid: a\ntitle: A\n---\nnew body"
    )
    assert idx.reindex(root) == 1
    assert MemoryService(db).recall("a").content.endswith("new body")


def test_indexer_parses_governance_fields(db, tmp_path):
    root = tmp_path / "agent-memory"
    _write_node(
        root,
        "potaeto",
        "provider-choice",
        "id: provider-choice\ntitle: Provider choice\n"
        "type: decision\nproject: potaeto\nconfidence: corroborated\nsource: opencode",
        "Potaeto uses OpenCode Go for routing.",
    )
    assert MemoryIndexer(db).reindex(root) == 1
    node = MemoryService(db).recall("provider-choice")
    assert node.scope == "project:potaeto"
    assert node.kind == "decision"
    assert node.source == "opencode"
    assert node.source_ref == "projects/potaeto/provider-choice.md"
    assert node.confidence == pytest.approx(0.85)  # `corroborated`
    assert not node.user_confirmed  # agent-written node is a candidate, not confirmed


def test_indexer_can_find_project_nodes_by_scope(db, tmp_path):
    root = tmp_path / "agent-memory"
    _write_node(
        root, "potaeto", "a", "id: a\ntitle: Alpha\nproject: potaeto\nsource: user", "alpha body"
    )
    MemoryIndexer(db).reindex(root)
    svc = MemoryService(db)
    assert [m.id for m in svc.search("u_local", "alpha", scope="project:potaeto")] == ["a"]
    assert svc.search("u_local", "alpha", scope="global") == []


def test_indexer_skips_files_without_frontmatter(db, tmp_path):
    root = tmp_path / "agent-memory"
    (root / "projects" / "potaeto").mkdir(parents=True)
    (root / "INDEX.md").write_text("# Index\n")
    _write_node(root, "potaeto", "a", "id: a\ntitle: A", "body")
    assert MemoryIndexer(db).reindex(root) == 1


def test_reindex_does_not_resurrect_a_retracted_memory(db, tmp_path):
    root = tmp_path / "agent-memory"
    path = _write_node(
        root, "potaeto", "secret", "id: secret\ntitle: Secret\nproject: potaeto", "blue"
    )
    idx = MemoryIndexer(db)
    assert idx.reindex(root) == 1
    svc = MemoryService(db)
    svc.retract("secret")
    path.write_text("---\nid: secret\ntitle: Secret\nproject: potaeto\n---\nblue changed")
    assert idx.reindex(root) == 1  # content refreshed, governance preserved
    assert idx.reindex(root) == 0
    assert svc.recall("secret").status == "retracted"
    assert svc.recall("secret").content.endswith("blue changed")
    assert svc.search("u_local", "blue", scope="project:potaeto") == []


# ---------------------------------------------------------------------------
# Agent tools
# ---------------------------------------------------------------------------


def test_tools_expose_the_seven_memory_operations(db):
    tools = MemoryTools(db)
    assert set(tools.as_tool_map()) == {
        "memory_search",
        "memory_recall",
        "memory_add",
        "memory_update",
        "memory_supersede",
        "memory_retract",
        "memory_journal",
    }


def test_tool_writes_default_to_unconfirmed_candidates(db):
    tools = MemoryTools(db)
    added = tools.memory_add("u1", "A web page says Provider A is best", source="web")
    assert added["user_confirmed"] in (False, 0)
    assert added["confidence"] < 0.9
    with pytest.raises(ValueError):
        tools.memory_add("u1", "no provenance", source="")

    journal = tools.memory_journal("u1", "Finished the memory task")
    assert journal["kind"] == "journal"
    assert journal["user_confirmed"] in (False, 0)


def test_tool_cannot_create_a_confirmed_fact(db):
    from app.agent.loop import AgentLoop, _call_with_context
    from app.db.repositories.audit import AuditRepo

    tools = MemoryTools(db)
    loop = AgentLoop(db, None)
    schema = loop._tool_schema("memory_add", tools.memory_add)
    assert "user_confirmed" not in schema["function"]["parameters"]["properties"]

    # A model-supplied hidden argument is dropped, not honored.
    added = _call_with_context(
        tools.memory_add,
        {
            "user_id": "u1",
            "content": "A web page says Provider A is best",
            "source": "web",
            "user_confirmed": True,
        },
        {},
    )
    assert added["user_confirmed"] in (False, 0)

    kinds = {event.kind for event in AuditRepo(db).list(limit=50)}
    assert "memory_add" in kinds


def test_memory_mutations_are_audited(db):
    from app.db.repositories.audit import AuditRepo

    tools = MemoryTools(db)
    first = tools.memory_add("u1", "Alex uses Provider A", source="user")
    tools.memory_update(first["id"], content="Alex uses Provider B")
    second = tools.memory_add("u1", "Alex uses Provider C", source="user")
    tools.memory_supersede(first["id"], second["id"])
    tools.memory_retract(second["id"])

    kinds = {event.kind for event in AuditRepo(db).list(limit=50)}
    assert {
        "memory_add",
        "memory_update",
        "memory_supersede",
        "memory_retract",
    } <= kinds


def test_tools_lifecycle(db):
    tools = MemoryTools(db)
    old = tools.memory_add("u1", "Alex uses Provider A", source="user")
    new = tools.memory_update(old["id"], content="Alex uses Provider B")
    assert new["content"] == "Alex uses Provider B"
    assert [m["id"] for m in tools.memory_search("u1", "Provider")] == [old["id"]]

    other = tools.memory_add("u1", "Alex uses Provider C", source="user")
    tools.memory_supersede(new["id"], other["id"])
    assert tools.memory_recall(new["id"])["status"] == "superseded"
    assert [m["id"] for m in tools.memory_search("u1", "Provider")] == [other["id"]]

    tools.memory_retract(other["id"])
    assert tools.memory_search("u1", "Provider") == []


def test_memory_search_defaults_to_the_tools_scope(db):
    """A bare search uses the configured scope, not hard-coded ``global``."""
    project = MemoryService(db).add(
        "u1", "e1", "fact", "Alex likes project coffee", "user", None, 0.9,
        "project:Anveshak", "normal", True,
    )

    project_tools = MemoryTools(db, default_scope="project:Anveshak")
    assert [m["id"] for m in project_tools.memory_search("u1", "coffee")] == [
        project.id
    ]

    # The historical default stays global-only, so project facts do not leak.
    assert MemoryTools(db).memory_search("u1", "coffee") == []


def test_memory_search_truncates_content_but_recall_returns_full(db):
    """Search results are pointers; recall is the explicit full expansion."""
    tools = MemoryTools(db)
    body = "detail " + "x" * 4_000
    added = tools.memory_add("u1", body, source="user")

    hit = tools.memory_search("u1", "detail")[0]
    marker = f"… (recall via memory_recall {added['id']})"
    assert hit["content"].endswith(marker)
    assert len(hit["content"]) == 1_600 + len(marker)
    assert hit["id"] == added["id"]
    assert tools.memory_recall(added["id"])["content"] == body

    # A short memory is returned verbatim.
    tools.memory_add("u1", "Alex likes tea", source="user")
    assert tools.memory_search("u1", "tea")[0]["content"] == "Alex likes tea"


# ---------------------------------------------------------------------------
# The seven memory evaluations from the design spec.
# ---------------------------------------------------------------------------


def test_eval_1_recall_after_server_restart(tmp_path):
    path = tmp_path / "restart.db"
    conn = connect_db(path)
    run_migrations(conn)
    m = _add(MemoryService(conn))
    conn.close()

    reopened = connect_db(path)
    try:
        run_migrations(reopened)
        assert [r.id for r in MemoryService(reopened).search("u1", "OpenCode")] == [m.id]
    finally:
        reopened.close()


def test_eval_2_recall_across_sessions(db):
    first = MemoryService(db).add(
        "u1", "e1", "fact", "Alex uses OpenCode Go", "conversation", "session-1",
        0.9, "global", "normal", True,
    )
    second = MemoryService(db).add(
        "u1", "e1", "fact", "Alex lives in Springfield", "conversation", "session-2",
        0.9, "global", "normal", True,
    )
    later = MemoryService(db)  # a fresh session reads both facts
    assert _ids(later.search("u1", "Alex")) == {first.id, second.id}


def test_eval_3_update_wins_over_old_fact(db):
    svc = MemoryService(db)
    m = _add(svc, "Alex uses Provider A")
    svc.update(m.id, content="Alex uses Provider B", confidence=0.95)

    assert svc.recall(m.id).content == "Alex uses Provider B"
    assert [r.id for r in svc.search("u1", "Provider")] == [m.id]
    assert svc.search("u1", "Provider B")[0].confidence == pytest.approx(0.95)


def test_eval_4_stale_fact_is_not_presented_as_current(db):
    svc = MemoryService(db)
    old = _add(svc, "Alex uses Provider A")
    new = _add(svc, "Alex uses Provider B")
    svc.supersede(old.id, new.id)
    expired = _add(svc, "Alex used Provider C", valid_to="2000-01-01 00:00:00")

    found = _ids(svc.search("u1", "Provider"))
    assert old.id not in found
    assert expired.id not in found
    assert new.id in found


def test_eval_5_retraction_removes_influence(db):
    tools = MemoryTools(db)
    m = tools.memory_add("u1", "Alex prefers dark mode", source="user")
    assert tools.memory_search("u1", "dark")[0]["id"] == m["id"]

    tools.memory_retract(m["id"])
    assert tools.memory_search("u1", "dark") == []
    assert tools.memory_recall(m["id"])["status"] == "retracted"


def test_eval_6_remembered_preference_drives_action(db):
    def format_distance(memories: list[dict], miles: float) -> str:
        """A stand-in for an agent action that consults memory first."""
        prefers_metric = any("metric" in memory["content"].lower() for memory in memories)
        return f"{miles * 1.609:.1f} km" if prefers_metric else f"{miles:.0f} mi"

    tools = MemoryTools(db)
    tools.memory_add(
        "u1", "Alex prefers metric units", source="user", kind="preference"
    )
    memories = tools.memory_search("u1", "metric units")
    assert format_distance(memories, 10) == "16.1 km"


def test_eval_7_project_scope_isolation(db):
    svc = MemoryService(db)
    shared = _add(svc, "Potaeto runs on the host")
    kraken = _add(svc, "Kraken budget is private", scope="project:kraken", source="document",
                  user_confirmed=False)
    atlas = _add(svc, "Atlas budget is separate", scope="project:atlas")

    assert _ids(svc.search("u1", "budget", scope="project:kraken")) == {kraken.id}
    assert _ids(svc.search("u1", "budget", scope="project:atlas")) == {atlas.id}
    unrelated = _ids(svc.search("u1", "budget", scope="project:unrelated"))
    assert kraken.id not in unrelated
    assert atlas.id not in unrelated
    # The default scope is global, so unrelated project facts never leak in
    # (the recency fallback may return the shared global memory).
    global_hits = _ids(svc.search("u1", "budget"))
    assert kraken.id not in global_hits
    assert atlas.id not in global_hits
    assert _ids(svc.search("u1", "host")) == {shared.id}
