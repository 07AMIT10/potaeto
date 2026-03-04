'use client';

import { useState } from 'react';

type Props = {
  entityId: string;
  onSuccess?: () => void;
};

export function SongwriterSkillCard({ entityId, onSuccess }: Props) {
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invoke = async () => {
    const text = prompt.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    setOutput('');

    try {
      const res = await fetch('/api/skills/songwriter/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, prompt: text }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? 'Skill invocation failed');
        return;
      }

      setOutput((data as { content?: string }).content ?? '');
      onSuccess?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-sm">
          <svg className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
        </div>
        <div>
          <span className="text-sm font-semibold">Songwriter</span>
          <span className="text-xs text-[var(--muted)] ml-2">Generate lyrics for this persona</span>
        </div>
      </div>
      <textarea
        className="input-field text-sm resize-y min-h-[56px]"
        placeholder="Describe the song (mood, genre, topic, references)..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={loading}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={invoke}
          disabled={loading || !prompt.trim()}
          className="btn-primary text-xs px-4 py-2"
        >
          {loading ? (
            <span className="inline-flex items-center gap-1.5">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Generating...
            </span>
          ) : (
            'Generate lyrics'
          )}
        </button>
        {error && <span className="text-xs text-red-500 truncate max-w-[50%]">{error}</span>}
      </div>
      {output && (
        <div className="rounded-xl bg-black/5 dark:bg-white/5 px-4 py-3 max-h-64 overflow-y-auto scrollbar-thin animate-fade-in">
          <pre className="whitespace-pre-wrap text-xs leading-relaxed font-sans">{output}</pre>
        </div>
      )}
    </div>
  );
}
