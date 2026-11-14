"""Piper Text-to-Speech runner with disk-based SHA-256 hash caching."""

from __future__ import annotations

import hashlib
import logging
import re
import subprocess
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


def sanitize_speech_text(text: str) -> str:
    """Sanitize text for speech synthesis by stripping emotive action tags and markdown symbols.

    Prevents TTS engines (like Piper) from speaking literal words like 'asterisk'.
    """
    # 1. Strip emotive action tags like *waves happily* or *smiles*
    cleaned = re.sub(r"(?<!\*)\*[^\s*](?:[^*\n]{0,118}[^\s*])?\*(?!\*)", "", text)
    # 2. Strip markdown headers (e.g. #, ##)
    cleaned = re.sub(r"#+\s*", "", cleaned)
    # 3. Strip bold/italic/strikethrough markers: **, __, ~~, `
    cleaned = re.sub(r"[*_~`]", "", cleaned)
    # 4. Collapse whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned if cleaned else text


def _write_fallback_wav(path: Path | str, duration_sec: float = 0.5) -> None:
    """Generate a minimal valid 16kHz 16-bit mono WAV file."""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)      # mono
        wf.setsampwidth(2)     # 16-bit
        wf.setframerate(16000) # 16kHz
        n_frames = int(16000 * duration_sec)
        wf.writeframes(b"\x00\x00" * n_frames)


class PiperTts:
    """Wraps Piper TTS CLI with SHA-256 hash caching of generated WAV files."""

    def __init__(
        self,
        model_path: str = "models/en_US-lessac-medium.onnx",
        cache_dir: str = "data/audio_cache",
    ) -> None:
        self.model_path = model_path
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def compute_cache_key(text: str, voice: str) -> str:
        """Deterministic sha256 hash of `f"{voice}:{text}"`."""
        raw = f"{voice}:{text}".encode()
        return hashlib.sha256(raw).hexdigest()

    def synthesize(self, text: str, voice: str = "en_US-lessac-medium") -> str:
        """Synthesize text to a WAV audio file, returning the file path.

        Checks if the cached WAV file already exists. If so, returns immediately.
        Otherwise, runs piper CLI synthesis or falls back to generating a valid WAV
        if the model or binary is not yet available.
        """
        cache_key = self.compute_cache_key(text, voice)
        output_file = self.cache_dir / f"{cache_key}.wav"

        # Cache hit: return immediately without invoking subprocess
        if output_file.exists():
            logger.debug("Piper TTS cache hit for key %s", cache_key)
            return str(output_file)

        logger.info("Piper TTS synthesizing key %s (voice=%s)", cache_key, voice)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        speech_text = sanitize_speech_text(text)

        try:
            subprocess.run(
                ["piper", "-m", str(self.model_path), "-f", str(output_file)],
                input=speech_text.encode(),
                capture_output=True,
                check=True,
            )
        except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
            logger.warning(
                "Piper synthesis failed or piper binary/model missing (%s); using fallback WAV",
                exc,
            )
            if not output_file.exists():
                _write_fallback_wav(output_file)

        if not output_file.exists():
            _write_fallback_wav(output_file)

        return str(output_file)
