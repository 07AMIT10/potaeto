'use client';

import { useState } from 'react';

type Props = {
  entityId: string;
};

export function SongwriterSkillCard({ entityId }: Props) {
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
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Songwriter</span>
        <span className="text-xs text-gray-500">Beta · generates lyrics for this persona</span>
      </div>
      <textarea
        className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm resize-y min-h-[60px]"
        placeholder="Describe the song you want (mood, genre, topic, references)…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={loading}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={invoke}
          disabled={loading || !prompt.trim()}
          className="inline-flex items-center rounded-lg bg-potato-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-potato-600 disabled:opacity-50"
        >
          {loading ? 'Generating…' : 'Generate lyrics'}
        </button>
        {error && <span className="text-xs text-red-500 truncate max-w-[60%]">{error}</span>}
      </div>
      {output && (
        <div className="mt-1 rounded-lg bg-gray-50 dark:bg-gray-900/70 px-3 py-2 max-h-64 overflow-y-auto">
          <pre className="whitespace-pre-wrap text-xs">{output}</pre>
        </div>
      )}
    </div>
  );
}

