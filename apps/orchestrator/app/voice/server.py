"""Standalone ASGI application for the potaeto-voice worker."""

from __future__ import annotations

from fastapi import FastAPI

from app.api.voice import router as voice_router

app = FastAPI(
    title="Potaeto Voice Subsystem",
    description="Piper TTS and Whisper STT voice worker",
    version="0.1.0",
)

app.include_router(voice_router)


@app.get("/health")
def health() -> dict[str, str]:
    """Health check endpoint for the voice worker."""
    return {"status": "ok", "service": "potaeto-voice"}
