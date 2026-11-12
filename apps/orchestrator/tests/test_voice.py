"""Tests for the Voice Subsystem (Piper TTS caching, Whisper STT, and voice API)."""

from __future__ import annotations

import struct
import subprocess
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.voice.stt import WhisperStt
from app.voice.tts import PiperTts


def _create_wav(
    path: Path | str,
    channels: int = 1,
    sampwidth: int = 2,
    framerate: int = 16000,
    duration_sec: float = 0.1,
) -> None:
    """Helper to generate a dummy WAV file."""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(framerate)
        n_frames = int(framerate * duration_sec)
        # 16-bit PCM silent/small tone
        if sampwidth == 2:
            samples = [int(1000 * (i % 10)) for i in range(n_frames * channels)]
            raw = struct.pack(f"<{len(samples)}h", *samples)
        else:
            raw = b"\x80" * (n_frames * channels)
        wf.writeframes(raw)


def test_tts_cache_key_generation(tmp_path: Path) -> None:
    """Cache key must be deterministic sha256 of f'{voice}:{text}'."""
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    key1 = tts.compute_cache_key("Hello world", "lessac")
    key2 = tts.compute_cache_key("Hello world", "lessac")
    key3 = tts.compute_cache_key("Different text", "lessac")
    key4 = tts.compute_cache_key("Hello world", "other_voice")

    assert key1 == key2
    assert key1 != key3
    assert key1 != key4
    assert len(key1) == 64


def test_tts_cache_hit_returns_existing_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When a cached WAV exists, return it immediately without invoking subprocess."""
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    cache_key = tts.compute_cache_key("Cached hello", "lessac")
    cached_file = tmp_path / f"{cache_key}.wav"
    cached_file.write_bytes(b"RIFF dummy cached wav data")

    # If subprocess.run is called on a cache hit, fail the test
    def fail_on_subprocess(*args, **kwargs):
        pytest.fail("subprocess.run must not be called on cache hit")

    monkeypatch.setattr(subprocess, "run", fail_on_subprocess)

    result_path = tts.synthesize("Cached hello", voice="lessac")
    assert result_path == str(cached_file)
    assert Path(result_path).read_bytes() == b"RIFF dummy cached wav data"


def test_tts_synthesize_miss_generates_file(tmp_path: Path) -> None:
    """When cache misses and piper is not installed, fallback generates a valid WAV."""
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    output_path = tts.synthesize("New audio prompt", voice="en_US-lessac-medium")

    assert Path(output_path).exists()
    assert Path(output_path).stat().st_size > 0

    # Ensure it's a readable WAV file
    with wave.open(output_path, "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 16000


def test_whisper_stt_transcribe_fallback(tmp_path: Path) -> None:
    """Transcribe a dummy 16kHz mono WAV falls back gracefully when whisper-cli is absent."""
    wav_file = tmp_path / "test.wav"
    _create_wav(wav_file, channels=1, sampwidth=2, framerate=16000)

    stt = WhisperStt(model_path="dummy.bin")
    text = stt.transcribe(str(wav_file))
    assert isinstance(text, str)
    assert len(text) > 0


def test_whisper_stt_transcode_stereo_and_mock_whisper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Transcodes non-16k stereo audio and reads whisper-cli output."""
    stereo_wav = tmp_path / "stereo_44k.wav"
    _create_wav(stereo_wav, channels=2, sampwidth=2, framerate=44100)

    stt = WhisperStt(model_path="dummy.bin")

    # Mock subprocess.run to simulate whisper-cli outputting a .txt file
    def mock_whisper_run(cmd, *args, **kwargs):
        f_idx = cmd.index("-f")
        input_wav = cmd[f_idx + 1]
        out_txt = Path(f"{input_wav}.txt")
        out_txt.write_text("Hello from simulated whisper transcription", encoding="utf-8")
        return MagicMock(returncode=0, stdout="")

    monkeypatch.setattr(subprocess, "run", mock_whisper_run)

    text = stt.transcribe(str(stereo_wav))
    assert text == "Hello from simulated whisper transcription"


def test_voice_api_synthesize(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """POST /v1/voice/synthesize returns WAV audio file."""
    monkeypatch.setenv("POTAETO_AUDIO_CACHE_DIR", str(tmp_path))
    # Reset singleton in voice module
    import app.api.voice as voice_module
    voice_module._tts = None

    response = client.post(
        "/v1/voice/synthesize",
        json={"text": "Hello voice synthesis", "voice": "en_US-lessac-medium"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF"


def test_voice_api_transcribe(client: TestClient, tmp_path: Path) -> None:
    """POST /v1/voice/transcribe accepts UploadFile and returns transcribed text."""
    dummy_wav = tmp_path / "sample.wav"
    _create_wav(dummy_wav)

    with open(dummy_wav, "rb") as f:
        response = client.post(
            "/v1/voice/transcribe",
            files={"file": ("sample.wav", f.read(), "audio/wav")},
        )

    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    assert isinstance(data["text"], str)


def test_voice_api_transcribe_missing_file_returns_400(client: TestClient) -> None:
    """POST /v1/voice/transcribe without file upload returns 400."""
    response = client.post("/v1/voice/transcribe")
    assert response.status_code == 400


def test_whisper_nonexistent_file_raises(tmp_path: Path) -> None:
    """WhisperStt raises FileNotFoundError if input file does not exist."""
    stt = WhisperStt(model_path="dummy.bin")
    with pytest.raises(FileNotFoundError):
        stt.transcribe(str(tmp_path / "does_not_exist.wav"))


def test_voice_standalone_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Standalone app in app.voice.server runs health and voice routes."""
    from app.voice.server import app as voice_app

    monkeypatch.setenv("POTAETO_AUDIO_CACHE_DIR", str(tmp_path))
    import app.api.voice as voice_module
    voice_module._tts = None

    client = TestClient(voice_app)
    health_res = client.get("/health")
    assert health_res.status_code == 200
    assert health_res.json()["service"] == "potaeto-voice"

    synth_res = client.post("/v1/voice/synthesize", json={"text": "Standalone test"})
    assert synth_res.status_code == 200
    assert synth_res.headers["content-type"] == "audio/wav"
