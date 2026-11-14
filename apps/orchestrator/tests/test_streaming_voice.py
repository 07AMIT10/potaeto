"""Unit tests for Streaming Voice subsystem:

- Sherpa-ONNX Zipformer STT (with fallback)
- Incremental Sentence Splitter
- Sentence-Streaming Piper TTS
- WebSockets /v1/voice/stream/stt and /v1/voice/stream/tts (including barge-in)
"""

from __future__ import annotations

import asyncio
import json
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.voice.streaming_stt import (
    FallbackStreamingSession,
    StreamingSttManager,
    resolve_zipformer_model_paths,
)
from app.voice.streaming_tts import SentenceSplitter, StreamingTtsManager
from app.voice.tts import PiperTts

# ---------------------------------------------------------------------------
# 1. SentenceSplitter Tests
# ---------------------------------------------------------------------------


def test_sentence_splitter_basic() -> None:
    splitter = SentenceSplitter()
    sentences = splitter.push("Hello world. How are you? I am fine!")
    assert sentences == ["Hello world.", "How are you?", "I am fine!"]
    assert splitter.flush() == []


def test_sentence_splitter_incremental_chunks() -> None:
    splitter = SentenceSplitter()
    assert splitter.push("Hello ") == []
    assert splitter.push("world. How ") == ["Hello world."]
    assert splitter.push("are you? ") == ["How are you?"]
    assert splitter.push("Just fine") == []
    assert splitter.flush() == ["Just fine"]


def test_sentence_splitter_newlines() -> None:
    splitter = SentenceSplitter()
    sentences = splitter.push("First line\nSecond line without punct\nThird line.")
    assert sentences == ["First line", "Second line without punct", "Third line."]
    assert splitter.flush() == []


def test_sentence_splitter_abbreviations_and_decimals() -> None:
    splitter = SentenceSplitter()
    sentences = splitter.push("Dr. Smith bought 3.14 meters of rope. Amazing!")
    assert sentences == ["Dr. Smith bought 3.14 meters of rope.", "Amazing!"]
    assert splitter.flush() == []


# ---------------------------------------------------------------------------
# 2. StreamingTtsManager Tests
# ---------------------------------------------------------------------------


def test_streaming_tts_synthesize_sentence_pcm(tmp_path: Path) -> None:
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    manager = StreamingTtsManager(tts=tts)

    pcm = manager.synthesize_sentence_pcm("Hello streaming test.")
    assert isinstance(pcm, bytes)
    assert len(pcm) > 0
    # 16kHz 16-bit mono = 2 bytes per sample (divisible by 2)
    assert len(pcm) % 2 == 0


@pytest.mark.asyncio
async def test_streaming_tts_stream_text_chunks_and_interruption(tmp_path: Path) -> None:
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    manager = StreamingTtsManager(tts=tts)
    interrupted_event = asyncio.Event()

    # Normal streaming
    chunks = []
    async for sentence, chunk in manager.stream_text_chunks(
        "First sentence. Second sentence.", interrupted_event=interrupted_event
    ):
        chunks.append((sentence, chunk))

    assert len(chunks) > 0
    assert chunks[0][0] == "First sentence."

    # Interrupted streaming
    interrupted_event.set()
    interrupted_chunks = []
    async for sentence, chunk in manager.stream_text_chunks(
        "Another sentence.", interrupted_event=interrupted_event
    ):
        interrupted_chunks.append((sentence, chunk))

    assert len(interrupted_chunks) == 0


# ---------------------------------------------------------------------------
# 3. StreamingSttManager & Sessions
# ---------------------------------------------------------------------------


def test_resolve_zipformer_model_paths() -> None:
    paths = resolve_zipformer_model_paths()
    if paths is not None:
        assert Path(paths["tokens"]).exists()
        assert Path(paths["encoder"]).exists()
        assert Path(paths["decoder"]).exists()
        assert Path(paths["joiner"]).exists()


def test_fallback_streaming_session() -> None:
    mock_stt = MagicMock()
    mock_stt.transcribe.return_value = "transcribed fallback utterance"

    session = FallbackStreamingSession(stt_runner=mock_stt, chunk_interval_sec=0.1)

    # 16kHz 16-bit mono = 32000 bytes/sec
    pcm_chunk = b"\x00\x00" * 3200  # 0.2s of audio
    events = session.process_chunk(pcm_chunk)
    assert len(events) >= 1
    assert events[0]["type"] == "partial"
    assert events[0]["text"] == "transcribed fallback utterance"

    final_events = session.finish()
    assert len(final_events) == 1
    assert final_events[0]["type"] == "final"


def test_sherpa_zipformer_real_audio() -> None:
    paths = resolve_zipformer_model_paths()
    if not paths:
        pytest.skip("Sherpa Zipformer models not found on disk")

    manager = StreamingSttManager(model_paths=paths)
    manager.initialize()
    if not manager._recognizer:
        pytest.skip("Sherpa-ONNX failed to load recognizer")

    test_wav = Path("apps/orchestrator/models/sherpa-zipformer/test_wavs/0.wav")
    if not test_wav.exists():
        pytest.skip("Test WAV file 0.wav not found")

    with wave.open(str(test_wav), "rb") as wf:
        pcm = wf.readframes(wf.getnframes())

    session = manager.create_session()
    events = []
    chunk_size = 3200  # 100ms
    for i in range(0, len(pcm), chunk_size):
        chunk = pcm[i : i + chunk_size]
        events.extend(session.process_chunk(chunk))

    events.extend(session.finish())
    assert len(events) > 0
    final_event = [e for e in events if e["type"] == "final"]
    assert len(final_event) >= 1
    assert "NIGHTFALL" in final_event[-1]["text"].upper()


# ---------------------------------------------------------------------------
# 4. WebSocket /v1/voice/stream/stt Tests
# ---------------------------------------------------------------------------


def test_websocket_stt_stream_fallback(client: TestClient) -> None:
    mock_stt = MagicMock()
    mock_stt.transcribe.return_value = "simulated live speech"
    manager = StreamingSttManager(fallback_stt_runner=mock_stt, chunk_interval_sec=0.1)
    manager._recognizer = None
    manager._initialized = True

    import app.api.voice as voice_module

    voice_module._stt_manager = manager

    with client.websocket_connect("/v1/voice/stream/stt") as ws:
        # Send audio PCM (> 0.1s so partial triggers)
        dummy_pcm = b"\x00\x00" * 4000
        ws.send_bytes(dummy_pcm)

        data = ws.receive_json()
        assert data["type"] == "partial"
        assert data["text"] == "simulated live speech"

        # Send flush to finalize
        ws.send_text(json.dumps({"type": "flush"}))
        final_data = ws.receive_json()
        assert final_data["type"] == "final"
        assert final_data["text"] == "simulated live speech"


# ---------------------------------------------------------------------------
# 5. WebSocket /v1/voice/stream/tts & Barge-in Tests
# ---------------------------------------------------------------------------


def test_websocket_tts_stream_sentences(client: TestClient, tmp_path: Path) -> None:
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    tts_mgr = StreamingTtsManager(tts=tts)

    import app.api.voice as voice_module

    voice_module._tts_manager = tts_mgr

    with client.websocket_connect("/v1/voice/stream/tts") as ws:
        ws.send_text(
            json.dumps({"type": "prompt", "text": "First sentence. Second sentence."})
        )

        # 1. Sentence 0 start
        msg1 = ws.receive_json()
        assert msg1["type"] == "sentence_start"
        assert msg1["sentence_index"] == 0
        assert msg1["text"] == "First sentence."

        # Receive PCM chunks until sentence_end
        pcm_chunks_0 = []
        while True:
            frame = ws.receive()
            if frame.get("bytes"):
                pcm_chunks_0.append(frame["bytes"])
            elif frame.get("text"):
                data = json.loads(frame["text"])
                if data.get("type") == "sentence_end":
                    assert data["sentence_index"] == 0
                    break

        assert len(pcm_chunks_0) > 0

        # 2. Sentence 1 start
        msg2 = ws.receive_json()
        assert msg2["type"] == "sentence_start"
        assert msg2["sentence_index"] == 1
        assert msg2["text"] == "Second sentence."

        # Receive PCM chunks until sentence_end
        pcm_chunks_1 = []
        while True:
            frame = ws.receive()
            if frame.get("bytes"):
                pcm_chunks_1.append(frame["bytes"])
            elif frame.get("text"):
                data = json.loads(frame["text"])
                if data.get("type") == "sentence_end":
                    assert data["sentence_index"] == 1
                    break

        assert len(pcm_chunks_1) > 0

        # 3. Done
        msg_done = ws.receive_json()
        assert msg_done["type"] == "done"


def test_websocket_tts_stream_barge_in(client: TestClient, tmp_path: Path) -> None:
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    tts_mgr = StreamingTtsManager(tts=tts)

    import app.api.voice as voice_module

    voice_module._tts_manager = tts_mgr

    with client.websocket_connect("/v1/voice/stream/tts") as ws:
        ws.send_text(json.dumps({"type": "prompt", "text": "Sentence to be cancelled."}))

        start_msg = ws.receive_json()
        assert start_msg["type"] == "sentence_start"

        # Client issues immediate barge_in
        ws.send_text(json.dumps({"type": "barge_in"}))

        interrupted_found = False
        for _ in range(15):
            frame = ws.receive()
            if frame.get("text"):
                data = json.loads(frame["text"])
                if data.get("type") == "interrupted":
                    interrupted_found = True
                    break

        assert interrupted_found is True


# ---------------------------------------------------------------------------
# 6. HTTP POST /v1/voice/stream/tts Tests
# ---------------------------------------------------------------------------


def test_http_stream_tts_post(client: TestClient, tmp_path: Path) -> None:
    tts = PiperTts(cache_dir=str(tmp_path), model_path="dummy.onnx")
    tts_mgr = StreamingTtsManager(tts=tts)

    import app.api.voice as voice_module

    voice_module._tts_manager = tts_mgr

    response = client.post(
        "/v1/voice/stream/tts",
        json={"text": "Hello HTTP stream TTS. Sentence two."},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/pcm"
    assert response.headers["x-audio-rate"] == "16000"
    assert len(response.content) > 0
    assert len(response.content) % 2 == 0
