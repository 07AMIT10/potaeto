"""Chunked, per-chat Telegram delivery for scheduler notifications."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence

from app.telegram.text import split_utf16

logger = logging.getLogger(__name__)

#: ``TelegramClient.send_message`` shape; duck-typed so tests can pass a fake.
SendMessage = Callable[[int, str], object]


async def send_notification(
    send: SendMessage, chat_ids: Sequence[int], text: str
) -> None:
    """Send `text` to every chat in Telegram-sized chunks.

    A failing chat is logged and skipped so the remaining chats still receive
    the message; after every chat has been attempted, a single error aggregates
    the failures so the scheduler records the run as failed. ``send`` is a
    short blocking call, so it runs in a worker thread.
    """
    failures: list[str] = []
    for chat_id in chat_ids:
        for chunk in split_utf16(text):
            try:
                await asyncio.to_thread(send, chat_id, chunk)
            except Exception as exc:  # noqa: BLE001 - isolate one bad chat
                logger.error("telegram notify to chat %s failed: %s", chat_id, exc)
                failures.append(f"chat {chat_id}: {exc}")
                break
    if failures:
        raise RuntimeError("; ".join(failures))
