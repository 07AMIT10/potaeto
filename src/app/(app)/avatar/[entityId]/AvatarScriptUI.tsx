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
    <div className="card overflow-hidden">
      <div className="p-5 border-b border-[var(--card-border)] flex flex-col sm:flex-row gap-5 items-start">
        <div className="w-20 h-20 rounded-2xl bg-potato-100 dark:bg-potato-900/30 flex items-center justify-center shrink-0 overflow-hidden">
          {avatarUrl ? (
            <Image src={avatarUrl} alt={entityName} width={80} height={80} className="object-cover w-full h-full" />
          ) : (
            <span className="text-3xl">{entityName.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <p className="text-sm text-[var(--muted)]">Generate a script for {entityName}</p>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional)"
            className="input-field"
          />
          <button
            type="button"
            onClick={generateScript}
            disabled={loadingScript}
            className="btn-primary text-sm"
          >
            {loadingScript ? (
              <span className="inline-flex items-center gap-1.5">
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating...
              </span>
            ) : (
              'Generate script'
            )}
          </button>
        </div>
      </div>
      <div className="p-5 space-y-4">
        <label className="label">Script (edit or paste)</label>
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={6}
          placeholder="Paste or generate a script, then play to hear it with TTS."
          className="input-field resize-y"
        />
        <div className="flex gap-2">
          {playing ? (
            <button type="button" onClick={stopTTS} className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-red-600 active:scale-[0.98]">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h6v4H9z" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={playTTS}
              disabled={!script.trim()}
              className="btn-primary"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Play voice
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
