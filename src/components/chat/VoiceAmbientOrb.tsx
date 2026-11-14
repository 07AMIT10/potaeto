'use client';

import React, { useState, useRef, useCallback } from 'react';
import { coreBaseUrl } from '@/components/providers/CoreProvider';
import { triggerHapticPoke } from '@/lib/avatar/potato-physics';

export interface VoiceAmbientOrbProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  isSpeaking?: boolean;
  className?: string;
}

export function VoiceAmbientOrb({
  onTranscript,
  disabled = false,
  isSpeaking = false,
  className = '',
}: VoiceAmbientOrbProps) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    triggerHapticPoke();
  }, []);

  const startRecording = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        alert('Microphone access is not supported on this device/browser.');
        return;
      }

      triggerHapticPoke();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];

      const mimeType =
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : '';

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);

        if (chunksRef.current.length === 0) return;

        setTranscribing(true);
        try {
          const audioBlob = new Blob(chunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          });
          const formData = new FormData();
          formData.append('file', audioBlob, 'speech.webm');

          const baseUrl = coreBaseUrl();
          const response = await fetch(`${baseUrl}/v1/voice/transcribe`, {
            method: 'POST',
            body: formData,
          });

          if (response.ok) {
            const data = (await response.json()) as { text?: string };
            if (data.text && data.text.trim()) {
              onTranscript(data.text.trim());
            }
          }
        } catch (err) {
          console.error('Transcription error:', err);
        } finally {
          setTranscribing(false);
        }
      };

      recorder.start(250);
      setRecording(true);
    } catch (err) {
      console.error('Failed to access microphone:', err);
      setRecording(false);
      setTranscribing(false);
    }
  }, [onTranscript]);

  const handleToggle = () => {
    if (disabled || transcribing) return;
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  return (
    <div className={`relative flex flex-col items-center justify-center ${className}`}>
      {/* Ambient Pulsating Rings */}
      {recording ? (
        <>
          <span className="absolute -inset-4 rounded-full bg-red-500/25 blur-lg animate-ping pointer-events-none" />
          <span className="absolute -inset-2 rounded-full bg-red-500/40 blur-md animate-pulse pointer-events-none" />
        </>
      ) : isSpeaking ? (
        <>
          <span className="absolute -inset-3 rounded-full bg-emerald-500/20 blur-md animate-pulse pointer-events-none" />
          <span className="absolute -inset-1 rounded-full bg-amber-400/25 blur-sm pointer-events-none" />
        </>
      ) : (
        <span className="absolute -inset-2.5 rounded-full bg-gradient-to-tr from-amber-500/20 via-potato-400/25 to-yellow-500/20 blur-md pointer-events-none transition-all duration-700" />
      )}

      {/* Main Glowing Circular Orb Button */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled || transcribing}
        aria-label={
          recording
            ? 'Stop recording speech'
            : transcribing
              ? 'Transcribing audio'
              : 'Tap to speak'
        }
        title={
          recording
            ? 'Tap to send voice message'
            : transcribing
              ? 'Transcribing...'
              : 'Tap to speak with Potaeto'
        }
        className={`relative z-10 flex items-center justify-center w-16 h-16 sm:w-20 sm:h-20 rounded-full text-white shadow-xl transition-all duration-200 outline-none select-none ${
          recording
            ? 'bg-gradient-to-tr from-red-600 to-rose-500 shadow-red-500/50 scale-105'
            : transcribing
              ? 'bg-amber-600 shadow-amber-500/40 cursor-wait'
              : isSpeaking
                ? 'bg-gradient-to-tr from-emerald-600 to-teal-500 shadow-emerald-500/30'
                : 'bg-gradient-to-tr from-amber-500 via-potato-500 to-amber-600 shadow-potato-500/35 hover:scale-105 active:scale-95'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {transcribing ? (
          <svg className="w-7 h-7 sm:w-8 sm:h-8 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : recording ? (
          <div className="flex flex-col items-center">
            {/* Square Stop Icon */}
            <div className="w-5 h-5 sm:w-6 sm:h-6 bg-white rounded-md shadow-xs animate-pulse" />
          </div>
        ) : (
          <svg
            className="w-7 h-7 sm:w-8 sm:h-8 drop-shadow-sm"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.2}
              d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
            />
          </svg>
        )}
      </button>

      {/* Subtitle Status */}
      <span className="mt-2 text-xs font-medium text-[var(--muted)]">
        {recording
          ? 'Listening... tap to send'
          : transcribing
            ? 'Transcribing audio...'
            : isSpeaking
              ? 'Speaking aloud...'
              : 'Tap to talk'}
      </span>
    </div>
  );
}
