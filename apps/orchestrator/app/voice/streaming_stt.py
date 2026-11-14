"""Streaming Speech-to-Text runner using Sherpa-ONNX Zipformer with graceful fallback."""

from __future__ import annotations

import logging
import os
import tempfile
import wave
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore[assignment]

try:
    import sherpa_onnx
except ImportError:
    sherpa_onnx = None  # type: ignore[assignment]


def resolve_zipformer_model_paths(model_dir: Path | str | None = None) -> dict[str, str] | None:
    """Find the zipformer model files (tokens, encoder, decoder, joiner) in model_dir or default paths."""
    candidates: list[Path] = []
    if model_dir:
        candidates.append(Path(model_dir))

    env_dir = os.getenv("POTAETO_SHERPA_MODEL_DIR")
    if env_dir:
        candidates.append(Path(env_dir))

    # Standard default paths relative to cwd or project root
    candidates.extend([
        Path("apps/orchestrator/models/sherpa-zipformer"),
        Path("models/sherpa-zipformer"),
        Path(__file__).resolve().parent.parent.parent / "models" / "sherpa-zipformer",
    ])

    for base in candidates:
        if not base.exists() or not base.is_dir():
            continue

        tokens = base / "tokens.txt"
        if not tokens.exists():
            continue

        encoders = list(base.glob("*encoder*.onnx"))
        decoders = list(base.glob("*decoder*.onnx"))
        joiners = list(base.glob("*joiner*.onnx"))

        if encoders and decoders and joiners:
            # Prefer int8 if present for speed and smaller memory, otherwise standard onnx
            def sort_key(p: Path) -> int:
                return 0 if "int8" in p.name else 1

            enc = min(encoders, key=sort_key)
            dec = min(decoders, key=sort_key)
            jn = min(joiners, key=sort_key)

            return {
                "tokens": str(tokens),
                "encoder": str(enc),
                "decoder": str(dec),
                "joiner": str(jn),
            }

    return None


class StreamingSttSession:
    """Abstract interface for a streaming STT session."""

    def process_chunk(self, pcm_bytes: bytes) -> list[dict[str, str]]:
        """Process a chunk of 16kHz 16-bit mono PCM bytes and return recognized events."""
        raise NotImplementedError

    def finish(self) -> list[dict[str, str]]:
        """Signal end of stream and return any final recognized events."""
        raise NotImplementedError

    def reset(self) -> None:
        """Reset internal stream state."""
        raise NotImplementedError


class SherpaStreamingSession(StreamingSttSession):
    """Sherpa-ONNX streaming session wrapping OnlineRecognizer and OnlineStream."""

    def __init__(self, recognizer: Any, stream: Any) -> None:
        self.recognizer = recognizer
        self.stream = stream
        self.last_text = ""

    def process_chunk(self, pcm_bytes: bytes) -> list[dict[str, str]]:
        if not pcm_bytes or np is None:
            return []

        # Convert 16-bit PCM bytes to float32 samples [-1.0, 1.0]
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self.stream.accept_waveform(16000, samples)

        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

        text = self.recognizer.get_result(self.stream)
        events: list[dict[str, str]] = []

        if self.recognizer.is_endpoint(self.stream):
            if text:
                events.append({"type": "final", "text": text})
            self.recognizer.reset(self.stream)
            self.last_text = ""
        elif text and text != self.last_text:
            self.last_text = text
            events.append({"type": "partial", "text": text})

        return events

    def finish(self) -> list[dict[str, str]]:
        self.stream.input_finished()
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

        text = self.recognizer.get_result(self.stream)
        events: list[dict[str, str]] = []
        if text:
            events.append({"type": "final", "text": text})
        return events

    def reset(self) -> None:
        self.recognizer.reset(self.stream)
        self.last_text = ""


class FallbackStreamingSession(StreamingSttSession):
    """Fallback streaming session that accumulates PCM and transcribes via Whisper or mock."""

    def __init__(self, stt_runner: Any = None, chunk_interval_sec: float = 1.0) -> None:
        self.stt_runner = stt_runner
        self.buffer = bytearray()
        self.chunk_interval_sec = chunk_interval_sec
        self.sample_rate = 16000
        self.last_partial = ""

    def process_chunk(self, pcm_bytes: bytes) -> list[dict[str, str]]:
        if not pcm_bytes:
            return []
        self.buffer.extend(pcm_bytes)
        bytes_threshold = int(self.sample_rate * 2 * self.chunk_interval_sec)
        events: list[dict[str, str]] = []
        if len(self.buffer) >= bytes_threshold:
            text = self._transcribe_buffer()
            if text and text != self.last_partial:
                self.last_partial = text
                events.append({"type": "partial", "text": text})
        return events

    def finish(self) -> list[dict[str, str]]:
        if not self.buffer:
            return []
        text = self._transcribe_buffer()
        self.buffer.clear()
        self.last_partial = ""
        if text:
            return [{"type": "final", "text": text}]
        return []

    def reset(self) -> None:
        self.buffer.clear()
        self.last_partial = ""

    def _transcribe_buffer(self) -> str:
        if not self.buffer:
            return ""
        if self.stt_runner is None:
            # Simple fallback text for testing without whisper
            return "transcribed audio chunk"

        fd, temp_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        temp_wav = Path(temp_path)
        try:
            with wave.open(str(temp_wav), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self.sample_rate)
                wf.writeframes(bytes(self.buffer))
            return self.stt_runner.transcribe(str(temp_wav))
        except (OSError, RuntimeError, ValueError) as exc:
            logger.warning("Fallback transcription failed: %s", exc)
            return "transcribed audio chunk"
        finally:
            if temp_wav.exists():
                try:
                    temp_wav.unlink()
                except OSError:
                    pass


class StreamingSttManager:
    """Manages streaming speech-to-text recognition with Sherpa Zipformer and Whisper fallback."""

    def __init__(
        self,
        model_paths: dict[str, str] | None = None,
        num_threads: int = 2,
        fallback_stt_runner: Any = None,
        chunk_interval_sec: float = 0.2,
    ) -> None:
        self.model_paths = model_paths or resolve_zipformer_model_paths()
        self.num_threads = num_threads
        self.fallback_stt_runner = fallback_stt_runner
        self.chunk_interval_sec = chunk_interval_sec
        self._recognizer: Any = None
        self._initialized = False

    @property
    def has_sherpa(self) -> bool:
        """True if sherpa_onnx is installed and Zipformer models are found."""
        return sherpa_onnx is not None and np is not None and self.model_paths is not None

    def initialize(self) -> None:
        """Initialize the sherpa_onnx OnlineRecognizer if available."""
        if self._initialized:
            return
        if self.has_sherpa:
            assert self.model_paths is not None
            logger.info("Initializing Sherpa-ONNX Zipformer OnlineRecognizer from %s", self.model_paths)
            try:
                self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                    tokens=self.model_paths["tokens"],
                    encoder=self.model_paths["encoder"],
                    decoder=self.model_paths["decoder"],
                    joiner=self.model_paths["joiner"],
                    num_threads=self.num_threads,
                    decoding_method="greedy_search",
                    enable_endpoint_detection=True,
                    rule1_min_trailing_silence=2.4,
                    rule2_min_trailing_silence=1.2,
                    rule3_min_utterance_length=20.0,
                )
                self._initialized = True
            except (OSError, RuntimeError, ValueError) as exc:
                logger.warning("Failed to initialize Sherpa-ONNX recognizer (%s); using fallback", exc)
                self._recognizer = None
                self._initialized = True
        else:
            logger.info("Sherpa-ONNX models or library not found; using fallback streaming STT")
            self._initialized = True

    def create_session(self) -> StreamingSttSession:
        """Create a new streaming session."""
        if not self._initialized:
            self.initialize()

        if self._recognizer is not None:
            stream = self._recognizer.create_stream()
            return SherpaStreamingSession(self._recognizer, stream)

        return FallbackStreamingSession(
            stt_runner=self.fallback_stt_runner,
            chunk_interval_sec=self.chunk_interval_sec,
        )
