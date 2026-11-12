"""Voice subsystem API endpoints for Piper TTS and Whisper STT."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

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
