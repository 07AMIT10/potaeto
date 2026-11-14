"""Voice subsystem API endpoints for Piper TTS, Whisper STT, and Streaming Voice."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    File,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.voice.streaming_stt import StreamingSttManager
from app.voice.streaming_tts import SentenceSplitter, StreamingTtsManager
from app.voice.stt import WhisperStt
from app.voice.tts import PiperTts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/voice", tags=["voice"])


class SynthesizeRequest(BaseModel):
    """Payload for text-to-speech synthesis."""

    text: str = Field(min_length=1, description="Text to synthesize to speech")
    voice: str | None = Field(default=None, description="Voice model identifier")


_tts: PiperTts | None = None
_stt: WhisperStt | None = None
_stt_manager: StreamingSttManager | None = None
_tts_manager: StreamingTtsManager | None = None


def get_tts() -> PiperTts:
    """Get or instantiate the Piper TTS runner."""
    global _tts
    if _tts is None:
        model_path = os.getenv("POTAETO_PIPER_MODEL", "models/en_US-lessac-medium.onnx")
        cache_dir = os.getenv("POTAETO_AUDIO_CACHE_DIR", "data/audio_cache")
        _tts = PiperTts(model_path=model_path, cache_dir=cache_dir)
    return _tts


def get_stt() -> WhisperStt:
    """Get or instantiate the Whisper STT runner."""
    global _stt
    if _stt is None:
        model_path = os.getenv("POTAETO_WHISPER_MODEL", "models/ggml-base.en.bin")
        _stt = WhisperStt(model_path=model_path)
    return _stt


def get_streaming_stt_manager() -> StreamingSttManager:
    """Get or instantiate the Streaming STT manager."""
    global _stt_manager
    if _stt_manager is None:
        _stt_manager = StreamingSttManager(fallback_stt_runner=get_stt())
    return _stt_manager


def get_streaming_tts_manager() -> StreamingTtsManager:
    """Get or instantiate the Streaming TTS manager."""
    global _tts_manager
    if _tts_manager is None:
        _tts_manager = StreamingTtsManager(tts=get_tts())
    return _tts_manager


@router.post("/synthesize")
def synthesize(request: SynthesizeRequest) -> FileResponse:
    """Synthesize text to speech using Piper TTS with SHA-256 hash caching."""
    tts = get_tts()
    voice = request.voice or "en_US-lessac-medium"
    wav_path = tts.synthesize(request.text, voice=voice)
    return FileResponse(
        wav_path,
        media_type="audio/wav",
        filename=Path(wav_path).name,
    )


@router.post("/transcribe")
async def transcribe(
    file: Annotated[UploadFile | None, File()] = None,
    audio: Annotated[UploadFile | None, File()] = None,
) -> dict[str, str]:
    """Transcribe an uploaded audio file using Whisper STT."""
    upload = file or audio
    if upload is None:
        raise HTTPException(status_code=400, detail="Missing audio file upload")

    suffix = Path(upload.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        content = await upload.read()
        tmp.write(content)

    try:
        stt = get_stt()
        text = stt.transcribe(str(tmp_path))
        return {"text": text}
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


@router.websocket("/stream/stt")
async def websocket_stt_stream(websocket: WebSocket) -> None:
    """Streaming STT WebSocket endpoint accepting 16kHz 16-bit PCM audio chunks.

    Emits {"type": "partial", "text": "..."} as words are recognized,
    and {"type": "final", "text": "..."} on end-of-utterance or client signal.
    """
    await websocket.accept()
    stt_manager = get_streaming_stt_manager()
    session = stt_manager.create_session()

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes"):
                events = session.process_chunk(message["bytes"])
                for ev in events:
                    await websocket.send_json(ev)
            elif message.get("text"):
                try:
                    payload = json.loads(message["text"])
                except json.JSONDecodeError:
                    payload = {"type": message["text"]}

                msg_type = payload.get("type", "")
                if msg_type in ("flush", "eof"):
                    events = session.finish()
                    for ev in events:
                        await websocket.send_json(ev)
                elif msg_type == "reset":
                    session.reset()
                    await websocket.send_json({"type": "reset_ack"})
    except WebSocketDisconnect:
        logger.debug("STT client disconnected from websocket")
    except (RuntimeError, OSError) as exc:
        logger.warning("Error in STT websocket stream: %s", exc)
        try:
            await websocket.send_json({"type": "error", "error": str(exc)})
        except (WebSocketDisconnect, OSError) as send_err:
            logger.debug("Could not send STT error frame: %s", send_err)


@router.websocket("/stream/tts")
async def websocket_tts_stream(websocket: WebSocket) -> None:
    """Sentence-Streaming Piper TTS WebSocket endpoint.

    Accepts text stream or full prompt, splits incrementally on sentence boundaries,
    and synthesizes each sentence directly to raw PCM audio chunks without waiting
    for the full response. Supports client cancellation {"type": "barge_in"}.
    """
    await websocket.accept()
    tts_manager = get_streaming_tts_manager()
    splitter = SentenceSplitter()
    interrupted_event = asyncio.Event()
    sentence_idx = 0
    active_worker_task: asyncio.Task[None] | None = None
    voice = "en_US-lessac-medium"

    async def synthesize_and_stream(sentences: list[str]) -> None:
        nonlocal sentence_idx
        try:
            for s in sentences:
                if interrupted_event.is_set():
                    break
                await websocket.send_json({
                    "type": "sentence_start",
                    "sentence_index": sentence_idx,
                    "text": s,
                })
                pcm_bytes = await asyncio.to_thread(tts_manager.synthesize_sentence_pcm, s, voice)
                if interrupted_event.is_set():
                    break

                chunk_size = 2048
                for offset in range(0, len(pcm_bytes), chunk_size):
                    if interrupted_event.is_set():
                        break
                    chunk = pcm_bytes[offset : offset + chunk_size]
                    await websocket.send_bytes(chunk)
                    await asyncio.sleep(0)

                if interrupted_event.is_set():
                    break

                await websocket.send_json({
                    "type": "sentence_end",
                    "sentence_index": sentence_idx,
                })
                sentence_idx += 1
        except asyncio.CancelledError:
            pass
        except (RuntimeError, OSError) as exc:
            logger.warning("Error during sentence streaming: %s", exc)

    try:
        while True:
            message = await websocket.receive()
            if message.get("text"):
                try:
                    payload = json.loads(message["text"])
                except json.JSONDecodeError:
                    payload = {"type": "prompt", "text": message["text"]}

                msg_type = payload.get("type", "prompt")
                if payload.get("voice"):
                    voice = payload["voice"]

                if msg_type == "barge_in":
                    logger.info("Received barge_in from client: interrupting TTS playback")
                    interrupted_event.set()
                    if active_worker_task and not active_worker_task.done():
                        active_worker_task.cancel()
                        try:
                            await active_worker_task
                        except (asyncio.CancelledError, OSError, RuntimeError) as task_err:
                            logger.debug("Active worker cancelled: %s", task_err)
                    splitter.reset()
                    await websocket.send_json({"type": "interrupted"})
                    interrupted_event.clear()

                elif msg_type == "prompt":
                    if active_worker_task and not active_worker_task.done():
                        interrupted_event.set()
                        active_worker_task.cancel()
                        try:
                            await active_worker_task
                        except (asyncio.CancelledError, OSError, RuntimeError) as task_err:
                            logger.debug("Previous worker cancelled: %s", task_err)
                        interrupted_event.clear()

                    prompt_text = payload.get("text", "")
                    sentences = splitter.push(prompt_text) + splitter.flush()
                    active_worker_task = asyncio.create_task(synthesize_and_stream(sentences))
                    await active_worker_task
                    if not interrupted_event.is_set():
                        await websocket.send_json({"type": "done"})

                elif msg_type == "text":
                    chunk_text = payload.get("text", "")
                    sentences = splitter.push(chunk_text)
                    if sentences:
                        active_worker_task = asyncio.create_task(synthesize_and_stream(sentences))
                        await active_worker_task

                elif msg_type == "flush":
                    sentences = splitter.flush()
                    if sentences:
                        active_worker_task = asyncio.create_task(synthesize_and_stream(sentences))
                        await active_worker_task
                    if not interrupted_event.is_set():
                        await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        logger.debug("TTS client disconnected from websocket")
    except (RuntimeError, OSError) as exc:
        logger.warning("Error in TTS websocket stream: %s", exc)
    finally:
        if active_worker_task and not active_worker_task.done():
            active_worker_task.cancel()


@router.post("/stream/tts")
async def stream_tts_post(request: SynthesizeRequest) -> StreamingResponse:
    """Sentence-streaming HTTP endpoint yielding raw 16kHz 16-bit mono PCM audio chunks."""
    tts_manager = get_streaming_tts_manager()
    voice = request.voice or "en_US-lessac-medium"

    async def pcm_generator():
        async for _sentence, chunk in tts_manager.stream_text_chunks(request.text, voice=voice):
            yield chunk

    return StreamingResponse(
        pcm_generator(),
        media_type="audio/pcm",
        headers={
            "X-Audio-Rate": "16000",
            "X-Audio-Channels": "1",
            "X-Audio-Format": "s16le",
        },
    )
