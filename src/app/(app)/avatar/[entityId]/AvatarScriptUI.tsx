'use client';

import { useState, useRef } from 'react';
import Image from 'next/image';

interface AvatarScriptUIProps {
  entityId: string;
  entityName: string;
  avatarUrl: string | null;
}

export function AvatarScriptUI({ entityId, entityName, avatarUrl }: AvatarScriptUIProps) {
  const [script, setScript] = useState('');
  const [topic, setTopic] = useState('');
  const [loadingScript, setLoadingScript] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const generateScript = async () => {
    setLoadingScript(true);
    try {
      const res = await fetch('/api/ai/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, topic: topic || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.script) setScript(data.script);
    } finally {
      setLoadingScript(false);
    }
  };

  const playTTS = async () => {
    if (!script.trim()) return;
    setPlaying(true);
    try {
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: script }),
      });
      if (!res.ok) {
        console.error('TTS failed');
        setPlaying(false);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setPlaying(false);
        URL.revokeObjectURL(url);
      };
      audio.play();
    } catch {
      setPlaying(false);
    }
  };

  const stopTTS = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlaying(false);
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 overflow-hidden">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex flex-col sm:flex-row gap-4 items-start">
        <div className="w-24 h-24 rounded-full bg-potato-200 dark:bg-potato-800 flex items-center justify-center shrink-0 overflow-hidden">
          {avatarUrl ? (
            <Image src={avatarUrl} alt={entityName} width={96} height={96} className="object-cover" />
          ) : (
            <span className="text-3xl text-potato-600" aria-hidden>🥔</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-500 mb-2">Generate a script for {entityName}</p>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional)"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm mb-2"
          />
          <button
            type="button"
            onClick={generateScript}
            disabled={loadingScript}
            className="rounded-lg bg-potato-500 px-4 py-2 text-sm font-medium text-white hover:bg-potato-600 disabled:opacity-50"
          >
            {loadingScript ? 'Generating…' : 'Generate script'}
          </button>
        </div>
      </div>
      <div className="p-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Script (edit or paste)
        </label>
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={6}
          placeholder="Paste or generate a script, then play to hear it with TTS."
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm mb-4"
        />
        <div className="flex gap-2">
          {playing ? (
            <button
              type="button"
              onClick={stopTTS}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={playTTS}
              disabled={!script.trim()}
              className="rounded-lg bg-potato-500 px-4 py-2 text-sm font-medium text-white hover:bg-potato-600 disabled:opacity-50"
            >
              Play voice
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
