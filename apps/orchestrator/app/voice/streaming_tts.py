"""Sentence-Streaming Piper TTS engine with incremental boundary splitting and barge-in support."""

from __future__ import annotations

import asyncio
import logging
import re
import wave
from collections.abc import AsyncIterator

from app.voice.tts import PiperTts

logger = logging.getLogger(__name__)


class SentenceSplitter:
    """Incremental sentence boundary splitter.

    Buffers text chunks until punctuation boundaries ('.', '?', '!', '\\n') are found,
    avoiding premature splitting on common abbreviations or decimal numbers.
    """

    def __init__(self) -> None:
        self.buffer = ""

    def push(self, chunk: str) -> list[str]:
        """Push an incoming text chunk and return any completed sentences."""
        if not chunk:
            return []

        self.buffer += chunk
        sentences: list[str] = []
        start_idx = 0

        while True:
            # Find punctuation (.?! followed by space or end) or newline
            match = re.search(r'(?:([.?!]+)(?:\s+|$)|([\r\n]+))', self.buffer[start_idx:])
            if not match:
                break

            term = match.group(1) or match.group(2)
            match_start = start_idx + match.start()
            match_end = start_idx + match.end()
            cand = self.buffer[: match_start + len(term)].strip()
            rest = self.buffer[match_end:]

            if match.group(1):
                # Avoid splitting on common abbreviations like Dr., Mr., vs., etc.
                if re.search(r"\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$", cand, re.IGNORECASE):
                    start_idx = match_end
                    continue
                # Avoid splitting on decimal numbers like 3.14
                if re.search(r"\d+\.$", cand) and re.match(r"^\d+", rest):
                    start_idx = match_end
                    continue

            if cand:
                sentences.append(cand)
            self.buffer = rest
            start_idx = 0

        return sentences

    def flush(self) -> list[str]:
        """Flush and return any remaining text in the buffer as the final sentence."""
        rem = self.buffer.strip()
        self.buffer = ""
        return [rem] if rem else []

    def reset(self) -> None:
        """Clear the splitter buffer."""
        self.buffer = ""


class StreamingTtsManager:
    """Manages sentence-streaming Piper TTS synthesis and PCM chunk delivery."""

    def __init__(self, tts: PiperTts | None = None) -> None:
        self.tts = tts or PiperTts()

    def synthesize_sentence_pcm(self, text: str, voice: str = "en_US-lessac-medium") -> bytes:
        """Synthesize a single sentence to raw 16kHz 16-bit mono PCM bytes using Piper."""
        if not text or not text.strip():
            return b""

        wav_path = self.tts.synthesize(text.strip(), voice=voice)
        try:
            with wave.open(wav_path, "rb") as wf:
                return wf.readframes(wf.getnframes())
        except (wave.Error, OSError) as exc:
            logger.warning("Failed to extract PCM frames from %s: %s", wav_path, exc)
            # Return minimal valid 16kHz 16-bit PCM silence as fallback
            return b"\x00\x00" * int(16000 * 0.2)

    async def stream_text_chunks(
        self,
        text: str,
        voice: str = "en_US-lessac-medium",
        chunk_size: int = 2048,
        interrupted_event: asyncio.Event | None = None,
    ) -> AsyncIterator[tuple[str, bytes]]:
        """Split text into sentences, synthesize each incrementally, and stream PCM chunks.

        Yields tuples of (sentence_text, pcm_chunk).
        Halts immediately if interrupted_event is set.
        """
        splitter = SentenceSplitter()
        sentences = splitter.push(text) + splitter.flush()

        for sentence in sentences:
            if interrupted_event and interrupted_event.is_set():
                logger.info("Streaming TTS interrupted before sentence: %s", sentence)
                break

            # Synthesize in threadpool to avoid blocking async event loop
            pcm_bytes = await asyncio.to_thread(self.synthesize_sentence_pcm, sentence, voice)

            if interrupted_event and interrupted_event.is_set():
                break

            # Stream PCM in chunks
            for offset in range(0, len(pcm_bytes), chunk_size):
                if interrupted_event and interrupted_event.is_set():
                    break
                chunk = pcm_bytes[offset : offset + chunk_size]
                yield sentence, chunk
                # Brief yield to event loop so cancellation/barge-in messages can be processed
                await asyncio.sleep(0)
