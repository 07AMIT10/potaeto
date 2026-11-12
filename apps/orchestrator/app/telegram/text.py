"""Telegram message limits and UTF-16-aware chunking.

Telegram counts ``message.text`` in UTF-16 code units (4096 max), so astral
characters such as emoji cost two units. Sharing the splitter keeps the bot and
the scheduler's notifications under the same limit.
"""

from __future__ import annotations

#: Telegram rejects messages longer than this many UTF-16 code units.
MAX_MESSAGE_LENGTH = 4096


def split_utf16(text: str, limit: int = MAX_MESSAGE_LENGTH) -> list[str]:
    """Split on code points without exceeding ``limit`` UTF-16 code units.

    Splitting by Python ``len`` would make emoji-heavy replies exceed the API
    limit and turn every send into a permanent 400.
    """
    if not text:
        return []
    chunks: list[str] = []
    current: list[str] = []
    units = 0
    for char in text:
        char_units = len(char.encode("utf-16-le")) // 2
        if current and units + char_units > limit:
            chunks.append("".join(current))
            current = []
            units = 0
        current.append(char)
        units += char_units
    if current:
        chunks.append("".join(current))
    return chunks
