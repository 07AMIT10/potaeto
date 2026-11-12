"""Tests for Approval Gating in Tool Registry, Agent Loop, and Telegram Inline Callbacks."""

import json
import pytest

from app.agent.loop import AgentEvent, AgentLoop
from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.tool_calls import ToolCallRepo
from app.providers.base import ChatRequest, StreamEvent
from app.telegram.bot import TelegramBot
from app.tools.registry import ApprovalRequiredError, ToolDefinition, ToolRegistry


@pytest.fixture()
def db_conn(db):
    """Alias for db fixture to support db_conn parameter name."""
    return db


class ToolCallingProvider:
    """Fake provider that streams a tool call delta."""

    def __init__(self, tool_name: str, arguments: dict):
        self.tool_name = tool_name
        self.arguments = arguments
        self.turn = 0

    async def stream_chat(self, request: ChatRequest):
        self.turn += 1
        if self.turn == 1:
            yield StreamEvent.tool_call_delta(
                index=0,
                id="call_test_1",
                name=self.tool_name,
                args=json.dumps(self.arguments),
            )
            yield StreamEvent.done("tool_calls")
        else:
            yield StreamEvent.token("All done!")
            yield StreamEvent.done("stop")


class MockTelegramClient:
    """Mock TelegramClient for testing inline callbacks and messages."""

    def __init__(self) -> None:
        self.sent: list[tuple[int, str]] = []
        self.sent_messages: list[dict] = []
        self.answered_callbacks: list[dict] = []
        self.edited_messages: list[dict] = []

    def send_message(
        self, chat_id: int, text: str, *, reply_markup: dict | None = None
    ) -> dict:
        self.sent.append((chat_id, text))
        self.sent_messages.append(
            {"chat_id": chat_id, "text": text, "reply_markup": reply_markup}
        )
        return {"ok": True}

    def answer_callback_query(
        self, callback_query_id: str, text: str | None = None, **kwargs
    ) -> dict:
        self.answered_callbacks.append(
            {"callback_query_id": callback_query_id, "text": text, **kwargs}
        )
        return {"ok": True}

    def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        *,
        reply_markup: dict | None = None,
        **kwargs,
    ) -> dict:
        self.edited_messages.append(
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "reply_markup": reply_markup,
                **kwargs,
            }
        )
        return {"ok": True}


def test_tool_requires_approval_flow(db_conn):
    """Tool requiring approval creates pending approval request and executes when approved."""
    repo = ApprovalRepo(db_conn)
    registry = ToolRegistry(approval_repo=repo)

    registry.register(
        ToolDefinition(
            name="dangerous_op",
            description="Performs risky operation",
            parameters={"type": "object", "properties": {"target": {"type": "string"}}},
            handler=lambda target: f"destroyed {target}",
            requires_approval=True,
        )
    )

    args = {"target": "all"}
    # First attempt: should raise ApprovalRequiredError
    with pytest.raises(ApprovalRequiredError) as exc_info:
        registry.execute("dangerous_op", args, user_id="u_local")

    req_id = exc_info.value.approval_id
    assert req_id.startswith("appr_")
    assert exc_info.value.tool_name == "dangerous_op"
    assert exc_info.value.arguments == args

    # Check pending in DB
    pending = repo.list_pending()
    assert len(pending) == 1
    assert pending[0]["id"] == req_id
    assert pending[0]["status"] == "pending"

    # Grant approval
    resolved = repo.resolve(req_id, decision="approved", resolved_by="u_local")
    assert resolved is not None
    assert resolved["status"] == "approved"

    # Second attempt: executes cleanly
    res = registry.execute("dangerous_op", args, user_id="u_local")
    assert res == "destroyed all"


def test_tool_rejected_flow(db_conn):
    """Rejected tool invocation does not execute and continues to require approval."""
    repo = ApprovalRepo(db_conn)
    registry = ToolRegistry(approval_repo=repo)

    registry.register(
        ToolDefinition(
            name="delete_database",
            handler=lambda: "deleted",
            requires_approval=True,
        )
    )

    with pytest.raises(ApprovalRequiredError) as exc_info:
        registry.execute("delete_database", {}, user_id="u_local")

    req_id = exc_info.value.approval_id
    resolved = repo.resolve(req_id, decision="rejected", resolved_by="u_admin")
    assert resolved is not None
    assert resolved["status"] == "rejected"

    # Second attempt: still raises ApprovalRequiredError
    with pytest.raises(ApprovalRequiredError):
        registry.execute("delete_database", {}, user_id="u_local")


def test_tool_preapproved_execution(db_conn):
    """Pre-approved action executes without raising ApprovalRequiredError."""
    repo = ApprovalRepo(db_conn)
    registry = ToolRegistry(approval_repo=repo)

    registry.register(
        ToolDefinition(
            name="system_reboot",
            handler=lambda reason: f"rebooting: {reason}",
            requires_approval=True,
        )
    )

    args = {"reason": "kernel update"}
    # Pre-create and approve request
    req = repo.create_request("system_reboot", args, requested_by="u_admin")
    repo.resolve(req["id"], decision="approved", resolved_by="u_admin")

    # Execution should succeed without raising
    res = registry.execute("system_reboot", args, user_id="u_admin")
    assert res == "rebooting: kernel update"


async def test_agent_loop_yields_approval_required_event(db_conn):
    """AgentLoop yields approval_required event and marks tool_call as pending_approval."""
    repo = ApprovalRepo(db_conn)
    provider = ToolCallingProvider("dangerous_command", {"command": "rm -rf /tmp/test"})

    registry = ToolRegistry(approval_repo=repo)
    registry.register(
        ToolDefinition(
            name="dangerous_command",
            handler=lambda command: f"ran {command}",
            requires_approval=True,
        )
    )

    loop = AgentLoop(db_conn, provider, tools=registry)
    conv_id = loop.ensure_conversation("u_local", "e_potaeto")

    events = [event async for event in loop.run(conv_id, "please run command")]
    types = [e.type for e in events]
    assert "tool_call" in types
    assert "approval_required" in types

    appr_event = next(e for e in events if e.type == "approval_required")
    assert appr_event.data["approval_id"].startswith("appr_")
    assert appr_event.data["tool_name"] == "dangerous_command"
    assert appr_event.data["arguments"] == {"command": "rm -rf /tmp/test"}

    # Verify tool call was recorded as pending_approval in SQLite
    tool_calls = ToolCallRepo(db_conn).list(status="pending_approval")
    assert len(tool_calls) == 1
    assert tool_calls[0].name == "dangerous_command"
    assert tool_calls[0].approval_id == appr_event.data["approval_id"]
    assert tool_calls[0].status == "pending_approval"


async def test_telegram_inline_callback_resolves_approval(db_conn):
    """Telegram callback query with 'appr:<id>:yes' resolves approval in DB and edits message."""
    repo = ApprovalRepo(db_conn)
    client = MockTelegramClient()
    bot = TelegramBot(client, db_conn, agent_loop=None, allowed_chat_ids={12345}, approval_repo=repo)

    # 1. Create a pending approval
    req = repo.create_request("deploy_prod", {"version": "2.0"}, requested_by="tg_12345")
    appr_id = req["id"]
    assert repo.is_approved(req["action_hash"]) is False

    # 2. Simulate Telegram callback query with "yes"
    cbq_update = {
        "update_id": 901,
        "callback_query": {
            "id": "cbq_001",
            "from": {"id": 12345, "first_name": "Admin"},
            "message": {
                "message_id": 88,
                "chat": {"id": 12345},
                "text": "Approval requested",
            },
            "data": f"appr:{appr_id}:yes",
        },
    }

    handled = await bot.handle_update(cbq_update)
    assert handled is True

    # 3. Verify approval in DB is approved
    assert repo.is_approved(req["action_hash"]) is True
    record = repo.get(appr_id)
    assert record is not None
    assert record["status"] == "approved"
    assert record["resolved_by"] == "tg_12345"

    # 4. Verify client calls
    assert len(client.answered_callbacks) == 1
    assert client.answered_callbacks[0]["callback_query_id"] == "cbq_001"
    assert client.answered_callbacks[0]["text"] == "Approved"

    assert len(client.edited_messages) == 1
    assert client.edited_messages[0]["chat_id"] == 12345
    assert client.edited_messages[0]["message_id"] == 88
    assert "Approved command" in client.edited_messages[0]["text"]


async def test_telegram_inline_callback_rejection(db_conn):
    """Telegram callback query with 'appr:<id>:no' marks approval rejected in DB."""
    repo = ApprovalRepo(db_conn)
    client = MockTelegramClient()
    bot = TelegramBot(client, db_conn, agent_loop=None, allowed_chat_ids={12345}, approval_repo=repo)

    req = repo.create_request("drop_table", {"table": "users"}, requested_by="tg_12345")
    appr_id = req["id"]

    cbq_update = {
        "update_id": 902,
        "callback_query": {
            "id": "cbq_002",
            "from": {"id": 12345},
            "message": {"message_id": 89, "chat": {"id": 12345}},
            "data": f"appr:{appr_id}:no",
        },
    }

    handled = await bot.handle_update(cbq_update)
    assert handled is True

    record = repo.get(appr_id)
    assert record is not None
    assert record["status"] == "rejected"
    assert repo.is_approved(req["action_hash"]) is False
    assert "Rejected" in client.answered_callbacks[0]["text"]
    assert "Rejected command" in client.edited_messages[0]["text"]


async def test_telegram_bot_sends_inline_keyboard_on_turn_approval_required(db_conn):
    """Telegram bot sends an inline keyboard when an agent turn requires tool approval."""
    repo = ApprovalRepo(db_conn)
    client = MockTelegramClient()

    provider = ToolCallingProvider("reboot_server", {"force": True})
    registry = ToolRegistry(approval_repo=repo)
    registry.register(
        ToolDefinition(
            name="reboot_server",
            handler=lambda force: "rebooted",
            requires_approval=True,
        )
    )

    loop = AgentLoop(db_conn, provider, tools=registry)
    bot = TelegramBot(client, db_conn, agent_loop=loop, allowed_chat_ids={12345}, approval_repo=repo)

    msg_update = {
        "update_id": 903,
        "message": {
            "chat": {"id": 12345},
            "text": "please reboot server",
        },
    }

    delivered = await bot.handle_update(msg_update)
    assert delivered is True

    # Bot should have sent an inline keyboard message
    assert len(client.sent_messages) == 1
    sent = client.sent_messages[0]
    assert sent["chat_id"] == 12345
    assert "Approval requested for tool: reboot_server" in sent["text"]
    reply_markup = sent["reply_markup"]
    assert reply_markup is not None
    inline_kb = reply_markup["inline_keyboard"]
    assert len(inline_kb) == 1
    buttons = inline_kb[0]
    assert buttons[0]["text"] == "✅ Approve"
    assert buttons[0]["callback_data"].startswith("appr:")
    assert buttons[0]["callback_data"].endswith(":yes")
    assert buttons[1]["text"] == "❌ Reject"
    assert buttons[1]["callback_data"].startswith("appr:")
    assert buttons[1]["callback_data"].endswith(":no")


async def test_telegram_unauthorized_chat_callback_rejected(db_conn):
    """Unauthorized Telegram chat callback is ignored and does not resolve approval."""
    repo = ApprovalRepo(db_conn)
    client = MockTelegramClient()
    bot = TelegramBot(client, db_conn, agent_loop=None, allowed_chat_ids={12345}, approval_repo=repo)

    req = repo.create_request("secret_action", {}, requested_by="u_admin")

    cbq_update = {
        "update_id": 904,
        "callback_query": {
            "id": "cbq_003",
            "from": {"id": 99999},  # unauthorized
            "message": {"message_id": 90, "chat": {"id": 99999}},
            "data": f"appr:{req['id']}:yes",
        },
    }

    handled = await bot.handle_update(cbq_update)
    assert handled is False
    assert repo.is_approved(req["action_hash"]) is False
    assert len(client.answered_callbacks) == 0
