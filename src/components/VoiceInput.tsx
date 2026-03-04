'use client';

import { useCallback, useEffect, useRef } from 'react';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

export function VoiceInput({ onTranscript, disabled, className }: VoiceInputProps) {
  const {
    transcript,
    listening,
    browserSupportsSpeechRecognition,
    resetTranscript,
  } = useSpeechRecognition();

  const lastSent = useRef('');

  useEffect(() => {
    if (transcript && transcript !== lastSent.current) {
      lastSent.current = transcript;
      onTranscript(transcript);
    }
  }, [transcript, onTranscript]);

  const toggle = useCallback(() => {
    if (listening) {
      SpeechRecognition.stopListening();
    } else {
      lastSent.current = '';
      resetTranscript();
      SpeechRecognition.startListening({ continuous: true });
    }
  }, [listening, resetTranscript]);

  if (!browserSupportsSpeechRecognition) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={
        className ??
        `rounded-full p-2.5 transition-all ${
          listening
            ? 'bg-red-500 text-white shadow-lg shadow-red-500/30 scale-110'
            : 'bg-black/5 dark:bg-white/5 text-[var(--muted)] hover:bg-potato-100 dark:hover:bg-potato-900/30 hover:text-potato-600'
        }`
      }
      title={listening ? 'Stop listening' : 'Start voice input'}
    >
      <span className="sr-only">{listening ? 'Stop' : 'Voice input'}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="w-5 h-5"
        aria-hidden
      >
        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
        <path d="M19 11a7 7 0 0 1-14 0h2a5 5 0 0 0 10 0h2Z" />
      </svg>
    </button>
  );
}
