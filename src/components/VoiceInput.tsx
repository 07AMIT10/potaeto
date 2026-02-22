'use client';

import { useCallback, useEffect } from 'react';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

export function VoiceInput({ onTranscript, disabled, className }: VoiceInputProps) {
  const {
    transcript,
    interimTranscript,
    listening,
    browserSupportsSpeechRecognition,
    resetTranscript,
  } = useSpeechRecognition();

  const fullText = (transcript || '') + (interimTranscript || '');

  useEffect(() => {
    if (fullText) onTranscript(fullText);
  }, [fullText, onTranscript]);

  const toggle = useCallback(() => {
    if (listening) {
      SpeechRecognition.stopListening();
    } else {
      resetTranscript();
      SpeechRecognition.startListening({ continuous: true });
    }
  }, [listening, resetTranscript]);

  if (!browserSupportsSpeechRecognition) {
    return (
      <span className="text-sm text-gray-500">Voice input not supported in this browser. Use Chrome for best support.</span>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={
        className ??
        `rounded-full p-3 transition ${
          listening
            ? 'bg-red-500 text-white'
            : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-potato-100 dark:hover:bg-potato-900'
        }`
      }
      title={listening ? 'Stop listening' : 'Start voice input'}
    >
      {listening ? (
        <span className="sr-only">Stop</span>
      ) : (
        <span className="sr-only">Voice input</span>
      )}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="w-6 h-6"
        aria-hidden
      >
        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
        <path d="M19 11a7 7 0 0 1-14 0h2a5 5 0 0 0 10 0h2Z" />
      </svg>
    </button>
  );
}
