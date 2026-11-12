import pytest
from fastapi.testclient import TestClient

from app.db.connection import connect_db, run_migrations


@pytest.fixture()
def db(tmp_path):
    conn = connect_db(tmp_path / "test.db")
    run_migrations(conn)
    yield conn
    conn.close()


@pytest.fixture()
def api_db():
    """In-memory DB shared by the `client` and `paired_device` fixtures."""
    conn = connect_db(":memory:")
    run_migrations(conn)
    yield conn
    conn.close()


@pytest.fixture()
def client(api_db):
    from app.config import Settings
    from app.main import create_app
    from app.scheduler.runner import Scheduler

    # Local dev runs over plain http://localhost, so the test client opts out of
    # the Secure cookie (the production default is True).
    app = create_app(Settings(db_path=":memory:", cookie_secure=False))
    # Share the migrated in-memory DB with the `paired_device` fixture.
    app.state.db.close()
    app.state.db = api_db
    app.state.scheduler = Scheduler(api_db)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def paired_device(api_db):
    from app.auth.pairing import PairingService
    from app.db.repositories.users import UserRepo

    UserRepo(api_db).create("u1", user_id="u1")
    service = PairingService(api_db)
    return service.exchange(service.create_code("u1"), "test-device")
