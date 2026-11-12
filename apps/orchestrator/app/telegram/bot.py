"""Allowlisted Telegram bot: long polling, durable update ids, commands.

Release 1 is remote *chat*, not a second Telegram client: free text goes to the
same :class:`~app.agent.loop.AgentLoop` as the PWA, tagged with
``channel="telegram"``. The bot is fail-closed — only configured chat ids are
answered, and an unknown chat is recorded silently.

Delivery is at-least-once. The update id is inserted before processing and
``processed_at`` is set only after the reply is sent, so a retry either
recognizes a finished update or re-runs the failed one. The loop receives a
deterministic client message id derived from the update id, which keeps a
retried user message from being stored twice.

Voice notes, TTS, and drafted streaming messages are Release 2.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from typing import Any

from app.db.constants import LOCAL_USER_ID, PRIMARY_ENTITY_ID
from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.base import fetch_one, transaction
from app.db.repositories.conversations import ConversationRepo
from app.db.repositories.jobs import JobRepo
from app.telegram.client import TelegramClient, TelegramError
from app.telegram.text import split_utf16
from app.tools.registry import ApprovalRequiredError

logger = logging.getLogger(__name__)

# How many times one update's reply may fail to send before it is acked anyway.
MAX_DELIVERY_ATTEMPTS = 3

# How many times the agent turn itself may fail (model/provider error) before
# the update is acked. Without a cap a permanent failure retries every poll and
# re-runs (and re-bills) the model forever.
MAX_AGENT_ATTEMPTS = 3

AGENT_FAILURE_REPLY = "Sorry — something went wrong. Please try again in a moment."

HELP_TEXT = (
    "Potaeto is online. Send a message to chat.\n"
    "Commands: /status, /model, /jobs, /memory, /pause, /resume"
)


class DeliveryRetry(RuntimeError):
    """A send failed transiently; retry this update after ``delay`` seconds."""

    def __init__(self, update_id: int, delay: float) -> None:
        super().__init__(f"delivery for update {update_id} deferred")
        self.update_id = update_id
        self.delay = max(0.0, float(delay))


class TelegramBot:
    """One long-polling loop over an allowlist of Telegram chats."""

    def __init__(
        self,
        client: TelegramClient,
        db: sqlite3.Connection,
        agent_loop: Any,
        allowed_chat_ids: set[int] | list[int],
        *,
        poll_timeout: int = 50,
        retry_delay: float = 1.0,
        approval_repo: ApprovalRepo | None = None,
    ) -> None:
        self.client = client
        self.db = db
        self.agent_loop = agent_loop
        self.allowed_chat_ids = {int(chat_id) for chat_id in allowed_chat_ids}
        self.poll_timeout = poll_timeout
        self.retry_delay = retry_delay
        self.conversations = ConversationRepo(db)
        self.approval_repo = (
            approval_repo if approval_repo is not None else ApprovalRepo(db)
        )
        self._paused: set[int] = set()
        # In-flight replies and send attempts survive redelivery of the same
        # update, so a failed send never re-runs (and re-bills) the agent.
        self._pending_replies: dict[int, str] = {}
        self._delivery_attempts: dict[int, int] = {}
        self._turn_attempts: dict[int, int] = {}

    # -- polling --------------------------------------------------------

    async def run_forever(self) -> None:
        """Poll until cancelled; an unacked update is retried, not skipped."""
        offset = self._resume_offset()
        while True:
            try:
                updates = await self.client.get_updates(offset, self.poll_timeout)
            except Exception:  # a poll failure must not kill the bot
                logger.exception("telegram polling failed")
                await asyncio.sleep(self.retry_delay)
                continue

            for item in updates:
                update_id = item.get("update_id")
                try:
                    await self.handle_update(item)
                except DeliveryRetry as exc:
                    logger.warning(
                        "telegram update %s delivery deferred for %.1fs",
                        update_id,
                        exc.delay,
                    )
                    await asyncio.sleep(exc.delay)
                    break
                except Exception:  # leave it unprocessed for retry
                    logger.exception("telegram update %s failed; will retry", update_id)
                    await asyncio.sleep(self.retry_delay)
                    break
                if isinstance(update_id, int):
                    offset = update_id + 1

            if not updates:
                await asyncio.sleep(self.retry_delay)

    def _resume_offset(self) -> int:
        """Resume at the oldest unprocessed update, else after the newest one."""
        row = fetch_one(
            self.db,
            "SELECT MIN(update_id) AS pending FROM telegram_updates "
            "WHERE processed_at IS NULL",
        )
        if row is not None and row["pending"] is not None:
            return int(row["pending"])
        newest = fetch_one(
            self.db,
            "SELECT COALESCE(MAX(update_id), 0) AS newest FROM telegram_updates",
        )
        return int(newest["newest"]) + 1

    # -- update handling ------------------------------------------------

    async def handle_update(self, update: dict[str, Any]) -> bool:
        """Process one update; False means ignored, duplicate, or undelivered."""
        update_id = update.get("update_id")
        if not isinstance(update_id, int):
            return False

        if "callback_query" in update:
            return await self._handle_callback_query_update(update)

        message = update.get("message")
        if not isinstance(message, dict):
            self._record_update(update_id, None)
            self._mark_processed(update_id)
            return False

        chat = message.get("chat") or {}
        chat_id = _as_int(chat.get("id"))
        if chat_id is None or chat_id not in self.allowed_chat_ids:
            # Fail closed: record the attempt, never reply.
            self._record_update(update_id, chat_id)
            self._mark_processed(update_id)
            return False

        self._record_update(update_id, chat_id)
        if self._is_processed(update_id):
            return False

        text = (message.get("text") or "").strip()
        if not text:
            # Stickers, voice notes, … are out of scope for Release 1.
            self._mark_processed(update_id)
            return False

        delivered = await self._process_text(update_id, chat_id, text)
        self._mark_processed(update_id)
        return delivered

    async def _handle_callback_query_update(self, update: dict[str, Any]) -> bool:
        update_id = update["update_id"]
        cbq = update.get("callback_query") or {}
        from_user = cbq.get("from") or {}
        chat_id = _as_int(from_user.get("id"))
        if chat_id is None:
            msg = cbq.get("message") or {}
            chat = msg.get("chat") or {}
            chat_id = _as_int(chat.get("id"))

        if chat_id is None or chat_id not in self.allowed_chat_ids:
            self._record_update(update_id, chat_id)
            self._mark_processed(update_id)
            return False

        self._record_update(update_id, chat_id)
        if self._is_processed(update_id):
            return False

        delivered = await self._handle_callback_query(update, chat_id=chat_id)
        self._mark_processed(update_id)
        return delivered

    async def _handle_callback_query(
        self, query_or_update: dict[str, Any], chat_id: int | None = None
    ) -> bool:
        """Handle an inline callback query (e.g. tool approval)."""
        if "callback_query" in query_or_update:
            cbq = query_or_update["callback_query"]
        else:
            cbq = query_or_update

        if chat_id is None:
            from_user = cbq.get("from") or {}
            chat_id = _as_int(from_user.get("id"))
            if chat_id is None:
                msg = cbq.get("message") or {}
                chat = msg.get("chat") or {}
                chat_id = _as_int(chat.get("id"))

        if chat_id is None or chat_id not in self.allowed_chat_ids:
            return False

        query_id = cbq.get("id")
        data = (cbq.get("data") or "").strip()
        if not data.startswith("appr:"):
            if query_id and hasattr(self.client, "answer_callback_query"):
                try:
                    await asyncio.to_thread(self.client.answer_callback_query, query_id)
                except Exception:
                    pass
            return False

        parts = data.split(":")
        if len(parts) < 3:
            return False

        approval_id = parts[1]
        decision_str = parts[2].lower()
        decision = "approved" if decision_str in ("yes", "approve") else "rejected"
        resolved_by = f"tg_{chat_id}"

        resolved = self.approval_repo.resolve(
            approval_id, decision, resolved_by=resolved_by
        )

        answer_text = "Approved" if decision == "approved" else "Rejected"
        if resolved is None:
            answer_text = "Expired or already resolved"

        if query_id and hasattr(self.client, "answer_callback_query"):
            try:
                await asyncio.to_thread(
                    self.client.answer_callback_query, query_id, text=answer_text
                )
            except Exception:
                logger.warning("failed to answer callback query %s", query_id)

        msg = cbq.get("message") or {}
        msg_id = msg.get("message_id") if isinstance(msg, dict) else None

        status_text = (
            "✅ Approved command" if decision == "approved" else "❌ Rejected command"
        )
        if resolved is None:
            status_text = f"⚠️ Approval {approval_id} already resolved or expired."

        if msg_id and hasattr(self.client, "edit_message_text"):
            try:
                await asyncio.to_thread(
                    self.client.edit_message_text, chat_id, msg_id, status_text
                )
            except Exception:
                await self._send(chat_id, status_text)
        else:
            await self._send(chat_id, status_text)

        return True

    async def _process_text(self, update_id: int, chat_id: int, text: str) -> bool:
        """Build (once) and deliver the reply; False means acked but undelivered."""
        command = _parse_command(text)
        if command is not None:
            return await self._deliver(
                update_id, chat_id, self._command_reply(chat_id, command)
            )

        if chat_id in self._paused:
            return await self._deliver(
                update_id, chat_id, "Paused. Send /resume to continue."
            )

        reply = self._pending_replies.get(update_id)
        if reply is None:
            attempts = self._turn_attempts.get(update_id, 0)
            try:
                reply = await self._run_turn(update_id, text)
            except ApprovalRequiredError as exc:
                self._clear_pending(update_id)
                reply_markup = {
                    "inline_keyboard": [
                        [
                            {"text": "✅ Approve", "callback_data": f"appr:{exc.approval_id}:yes"},
                            {"text": "❌ Reject", "callback_data": f"appr:{exc.approval_id}:no"},
                        ]
                    ]
                }
                msg_text = (
                    f"⚠️ Approval requested for tool: {exc.tool_name}\n"
                    f"Args: {json.dumps(exc.arguments)}"
                )
                await asyncio.to_thread(
                    self.client.send_message,
                    chat_id,
                    msg_text,
                    reply_markup=reply_markup,
                )
                return True
            except Exception:
                attempts += 1
                self._turn_attempts[update_id] = attempts
                if attempts < MAX_AGENT_ATTEMPTS:
                    raise
                logger.exception(
                    "telegram update %s agent turn failed after %s attempts; acking",
                    update_id,
                    attempts,
                )
                self._clear_pending(update_id)
                # Best effort: the turn itself is dead, but the user should not
                # be left staring at silence.
                try:
                    await self._send(chat_id, AGENT_FAILURE_REPLY)
                except TelegramError:
                    logger.warning(
                        "telegram update %s could not send the failure notice",
                        update_id,
                    )
                return False
            self._pending_replies[update_id] = reply
        return await self._deliver(update_id, chat_id, reply)

    async def _run_turn(self, update_id: int, text: str) -> str:
        conversation_id = self.conversations.ensure_conversation(
            LOCAL_USER_ID, PRIMARY_ENTITY_ID
        ).id
        parts: list[str] = []
        error: str | None = None
        async for event in self.agent_loop.run(
            conversation_id,
            text,
            "telegram",
            client_message_id=f"m_tg_{update_id}",
        ):
            if event.type == "token":
                parts.append(str(event.data.get("text") or ""))
            elif event.type == "approval_required":
                raise ApprovalRequiredError(
                    event.data["approval_id"],
                    event.data["tool_name"],
                    event.data["arguments"],
                )
            elif event.type == "error":
                error = str(event.data.get("message") or "the agent failed")

        reply = "".join(parts)
        if not reply:
            reply = f"Sorry — {error}" if error else "(no response)"
        return reply

    # -- commands -------------------------------------------------------

    def _command_reply(self, chat_id: int, command: str) -> str:
        if command == "start":
            return HELP_TEXT
        if command == "status":
            paused = "yes" if chat_id in self._paused else "no"
            return f"Status: ok\nModel: {self._model()}\nPaused: {paused}"
        if command == "model":
            return (
                f"Model: {self._model()}\n"
                "Model switching isn't available yet (later release)."
            )
        if command == "jobs":
            count = len(JobRepo(self.db).list())
            return (
                f"{count} job(s) configured. The scheduler arrives in a later release."
            )
        if command == "memory":
            count = fetch_one(
                self.db,
                "SELECT COUNT(*) FROM memories WHERE deleted = 0 AND status = 'active'",
            )[0]
            return (
                f"Memory: {count} active memories. "
                "Memory management arrives in a later release."
            )
        if command == "pause":
            self._paused.add(chat_id)
            return "Paused. Send /resume to continue."
        if command == "resume":
            self._paused.discard(chat_id)
            return "Resumed. Send a message to chat."
        return f"Unknown command /{command}. Send /start for the command list."

    def _model(self) -> str:
        return getattr(self.agent_loop, "model", "") or "not configured"

    # -- delivery and durability ---------------------------------------

    def send_long(self, chat_id: int, text: str) -> None:
        """Send ``text`` in Telegram-sized chunks (4096 UTF-16 code units)."""
        for chunk in split_utf16(text):
            self.client.send_message(chat_id, chunk)

    async def _send(self, chat_id: int, text: str) -> None:
        """Send without blocking the app's event loop on a network call."""
        await asyncio.to_thread(self.send_long, chat_id, text)

    async def _deliver(self, update_id: int, chat_id: int, text: str) -> bool:
        """Deliver a reply, classifying failures instead of wedging the queue.

        Permanent 4xx errors are acked immediately because retrying cannot
        succeed. Transient errors raise :class:`DeliveryRetry` (honouring a 429
        ``retry_after``) until :data:`MAX_DELIVERY_ATTEMPTS`, after which the
        update is acked with an error log so the queue head cannot block.
        """
        attempts = self._delivery_attempts.get(update_id, 0)
        try:
            await self._send(chat_id, text)
        except TelegramError as exc:
            attempts += 1
            self._delivery_attempts[update_id] = attempts
            if exc.permanent:
                logger.error(
                    "telegram update %s delivery failed permanently (HTTP %s); acking",
                    update_id,
                    exc.status,
                )
                self._clear_pending(update_id)
                return False
            if attempts >= MAX_DELIVERY_ATTEMPTS:
                logger.error(
                    "telegram update %s delivery failed after %s attempts (%s); acking",
                    update_id,
                    attempts,
                    exc,
                )
                self._clear_pending(update_id)
                return False
            delay = exc.retry_after if exc.retry_after is not None else self.retry_delay
            raise DeliveryRetry(update_id, delay) from None

        self._clear_pending(update_id)
        return True

    def _clear_pending(self, update_id: int) -> None:
        self._pending_replies.pop(update_id, None)
        self._delivery_attempts.pop(update_id, None)
        self._turn_attempts.pop(update_id, None)

    def _record_update(self, update_id: int, chat_id: int | None) -> None:
        with transaction(self.db):
            self.db.execute(
                "INSERT OR IGNORE INTO telegram_updates (update_id, chat_id) "
                "VALUES (?, ?)",
                (update_id, chat_id),
            )

    def _is_processed(self, update_id: int) -> bool:
        row = fetch_one(
            self.db,
            "SELECT processed_at FROM telegram_updates WHERE update_id = ?",
            (update_id,),
        )
        return bool(row is not None and row["processed_at"])

    def _mark_processed(self, update_id: int) -> None:
        with transaction(self.db):
            self.db.execute(
                "UPDATE telegram_updates SET processed_at = datetime('now') "
                "WHERE update_id = ?",
                (update_id,),
            )


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_command(text: str) -> str | None:
    first = text.split(maxsplit=1)[0]
    if not first.startswith("/"):
        return None
    return first[1:].split("@", 1)[0].lower()
