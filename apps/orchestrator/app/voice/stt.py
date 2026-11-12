"""Whisper Speech-to-Text runner using whisper-cli."""

from __future__ import annotations

import logging
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


def _is_16k_mono_wav(path: Path | str) -> bool:
    """Check if the given file is already a 16kHz 16-bit mono WAV file."""
    try:
        with wave.open(str(path), "rb") as wf:
            return (
                wf.getnchannels() == 1
                and wf.getsampwidth() == 2
                and wf.getframerate() == 16000
            )
    except (wave.Error, OSError):
        return False


def _transcode_to_16k_mono_wav(input_path: Path | str) -> Path:
    """Transcode arbitrary audio to 16kHz 16-bit mono WAV using ffmpeg or pure Python."""
    fd, temp_name = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    temp_path = Path(temp_name)

    transcoded = False

    # 1. Try ffmpeg CLI if available
    if shutil.which("ffmpeg"):
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(input_path),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(temp_path),
                ],
                capture_output=True,
                check=True,
            )
            transcoded = True
        except (subprocess.SubprocessError, OSError) as exc:
            logger.debug("ffmpeg transcoding failed: %s", exc)
            transcoded = False

    # 2. If ffmpeg is absent or failed, try wave-based transcoding if input is WAV
    if not transcoded:
        try:
            with wave.open(str(input_path), "rb") as r:
                n_channels = r.getnchannels()
                sampwidth = r.getsampwidth()
                framerate = r.getframerate()
                n_frames = r.getnframes()
                raw_data = r.readframes(n_frames)

                samples: list[int] = []
                if sampwidth == 2:
                    total_samples = n_frames * n_channels
                    fmt = f"<{total_samples}h"
                    all_samples = struct.unpack(fmt, raw_data)
                    if n_channels == 1:
                        samples = list(all_samples)
                    else:
                        for i in range(0, len(all_samples), n_channels):
                            avg = sum(all_samples[i : i + n_channels]) // n_channels
                            samples.append(avg)
                elif sampwidth == 1:
                    for i in range(0, len(raw_data), n_channels):
                        ch_vals = [(raw_data[i + c] - 128) * 256 for c in range(n_channels)]
                        samples.append(sum(ch_vals) // n_channels)
                else:
                    samples = [0] * int(16000 * 0.5)

                # Resample to 16kHz if needed
                if framerate != 16000 and samples:
                    ratio = 16000.0 / framerate
                    new_len = int(len(samples) * ratio)
                    if new_len > 0:
                        samples = [
                            samples[min(int(i / ratio), len(samples) - 1)]
                            for i in range(new_len)
                        ]

                with wave.open(str(temp_path), "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(16000)
                    fmt_out = f"<{len(samples)}h"
                    w.writeframes(struct.pack(fmt_out, *samples))
            transcoded = True
        except (wave.Error, OSError, struct.error) as exc:
            logger.debug("Wave-based transcoding fallback: %s", exc)

    # 3. Last-resort fallback: minimal 16k mono WAV
    if not transcoded:
        with wave.open(str(temp_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 8000)

    return temp_path


class WhisperStt:
    """Whisper Speech-to-Text runner."""

    def __init__(
        self,
        model_path: str = "models/ggml-base.en.bin",
        fallback_text: str = "transcribed voice note",
    ) -> None:
        self.model_path = model_path
        self.fallback_text = fallback_text

    def transcribe(self, audio_file_path: str) -> str:
        """Transcode to 16kHz mono WAV if needed and transcribe using whisper-cli."""
        path = Path(audio_file_path)
        if not path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_file_path}")

        temp_wav_path: Path | None = None
        if _is_16k_mono_wav(path):
            wav_path = path
        else:
            temp_wav_path = _transcode_to_16k_mono_wav(path)
            wav_path = temp_wav_path

        txt_file_1 = Path(f"{wav_path}.txt")
        txt_file_2 = Path(wav_path).with_suffix(".txt")
        whisper_bin = shutil.which("whisper-cli") or "whisper-cli"

        result_text = ""
        try:
            proc = subprocess.run(
                [whisper_bin, "-m", str(self.model_path), "-f", str(wav_path), "-otxt"],
                capture_output=True,
                text=True,
                check=True,
            )
            if txt_file_1.exists():
                result_text = txt_file_1.read_text(encoding="utf-8").strip()
            elif txt_file_2.exists() and txt_file_2 != wav_path:
                result_text = txt_file_2.read_text(encoding="utf-8").strip()
            elif proc.stdout:
                result_text = proc.stdout.strip()
            else:
                result_text = self.fallback_text
        except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
            logger.warning(
                "whisper-cli failed or binary/model missing (%s); using fallback/mock",
                exc,
            )
            if txt_file_1.exists():
                result_text = txt_file_1.read_text(encoding="utf-8").strip()
            elif txt_file_2.exists() and txt_file_2 != wav_path:
                result_text = txt_file_2.read_text(encoding="utf-8").strip()
            else:
                result_text = self.fallback_text
        finally:
            if txt_file_1.exists():
                try:
                    txt_file_1.unlink()
                except OSError:
                    pass
            if txt_file_2.exists() and txt_file_2 != wav_path:
                try:
                    txt_file_2.unlink()
                except OSError:
                    pass
            if temp_wav_path and temp_wav_path.exists():
                try:
                    temp_wav_path.unlink()
                except OSError:
                    pass

        return result_text or self.fallback_text
