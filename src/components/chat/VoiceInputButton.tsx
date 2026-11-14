'use client';

import { useState, useRef, useCallback } from 'react';
import { coreBaseUrl } from '@/components/providers/CoreProvider';

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export function VoiceInputButton({ onTranscript, disabled }: VoiceInputButtonProps) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        alert('Microphone access is not supported on this device/browser.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];

      // Prefer audio/webm if supported, else default audio format
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
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
        // Stop all audio tracks so the mic indicator turns off
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

      recorder.start(250); // Slice every 250ms
      setRecording(true);
    } catch (err) {
      console.error('Failed to access microphone:', err);
      setRecording(false);
      setTranscribing(false);
    }
  }, [onTranscript]);

  const toggle = () => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || transcribing}
      aria-label={
        transcribing
          ? 'Transcribing audio...'
          : recording
            ? 'Stop recording and transcribe'
            : 'Start voice input'
      }
      title={
        transcribing
          ? 'Transcribing...'
          : recording
            ? 'Tap to send voice'
            : 'Tap to speak'
      }
      className={`p-2.5 rounded-xl border transition-all flex items-center justify-center shrink-0 ${
        recording
          ? 'bg-red-500 text-white border-red-600 shadow-md shadow-red-500/30 animate-pulse'
          : transcribing
            ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700'
            : 'bg-[var(--card)] hover:bg-potato-100 dark:hover:bg-potato-900/30 text-[var(--muted)] hover:text-potato-600 border-[var(--card-border)]'
      }`}
    >
      {transcribing ? (
        <svg
          className="w-4 h-4 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
      ) : recording ? (
        <svg
          className="w-4 h-4"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z"
          />
        </svg>
      )}
    </button>
  );
}
