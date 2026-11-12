"""Seven formal memory evaluation scenarios from the sentient agent spec §7.7."""

import pytest
from app.agent.loop import AgentLoop
from app.db.connection import connect_db, run_migrations
from app.memory.service import MemoryService


@pytest.fixture()
def db_conn(tmp_path):
    conn = connect_db(tmp_path / "evals.db")
    run_migrations(conn)
    yield conn
    conn.close()


# Scenario 1: Recall a fact after a server restart (DB reconnection)
def test_eval_1_restart_recall(tmp_path, db_conn):
    mem = MemoryService(db_conn)
    node_id = mem.add(title="Preferred editor", body="User prefers Neovim", scope="project:Anveshak")
    # Simulate restart by reading through fresh service
    fresh_mem = MemoryService(db_conn)
    recalled = fresh_mem.search("preferred editor", scope="project:Anveshak")
    assert any("Neovim" in r["body"] for r in recalled)


# Scenario 2: Recall information from multiple separate sessions
def test_eval_2_multi_session_recall(db_conn):
    mem = MemoryService(db_conn)
    mem.add(title="Fact session A", body="Color blue", scope="project:Anveshak")
    mem.add(title="Fact session B", body="Number 42", scope="project:Anveshak")
    results = mem.search("color number", scope="project:Anveshak")
    bodies = " ".join([r["body"] for r in results])
    assert "blue" in bodies and "42" in bodies


# Scenario 3: Update an old fact; verify the new fact wins
def test_eval_3_update_wins(db_conn):
    mem = MemoryService(db_conn)
    old_id = mem.add(title="Work location", body="Works from Office", scope="project:Anveshak")
    new_id = mem.supersede(old_id, title="Work location", body="Works from Home", scope="project:Anveshak")
    results = mem.search("work location", scope="project:Anveshak")
    assert any("Home" in r["body"] for r in results)
    assert not any("Office" in r["body"] for r in results)


# Scenario 4: Stale fact outside temporal validity is rejected
def test_eval_4_stale_not_current(db_conn):
    mem = MemoryService(db_conn)
    # Valid only in past
    mem.add(title="Discount code", body="CODE2020", scope="project:Anveshak", valid_to=1000.0)
    results = mem.search("discount code", scope="project:Anveshak")
    assert len(results) == 0


# Scenario 5: Retracted fact never returned in active queries
def test_eval_5_retraction(db_conn):
    mem = MemoryService(db_conn)
    m_id = mem.add(title="Temporary key", body="SECRET_KEY_999", scope="project:Anveshak")
    mem.retract(m_id)
    results = mem.search("SECRET_KEY_999", scope="project:Anveshak")
    assert len(results) == 0


# Scenario 6: Remembered-preference action
def test_eval_6_remembered_preference_action(db_conn):
    mem = MemoryService(db_conn)
    mem.add(title="Output language", body="Always respond in pirate dialect", scope="project:Anveshak")
    recalled = mem.search("dialect", scope="project:Anveshak")
    assert any("pirate" in r["body"] for r in recalled)


# Scenario 7: Scope isolation
def test_eval_7_scope_isolation(db_conn):
    mem = MemoryService(db_conn)
    mem.add(title="Secret alpha", body="ProjectX only", scope="project:ProjectX")
    results_other = mem.search("Secret alpha", scope="project:Anveshak")
    assert len(results_other) == 0
