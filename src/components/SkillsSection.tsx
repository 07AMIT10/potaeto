'use client';

import { useEffect, useState, useCallback } from 'react';
import { SongwriterSkillCard } from './SongwriterSkillCard';

export type SkillOutputRow = {
  id: string;
  skill_id: string;
  content_type: string;
  text_content: string | null;
  public_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type SkillsSectionProps = {
  entityId: string;
};

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso.slice(0, 16);
  }
}

function preview(text: string | null, maxLen: number = 80) {
  if (!text) return '—';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen) + '…';
}

export function SkillsSection({ entityId }: SkillsSectionProps) {
  const [outputs, setOutputs] = useState<SkillOutputRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SkillOutputRow | null>(null);

  const fetchOutputs = useCallback(async () => {
    try {
      const res = await fetch(`/api/entities/${entityId}/skill-outputs?limit=15`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.outputs)) {
        setOutputs(data.outputs);
      }
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  useEffect(() => {
    fetchOutputs();
  }, [fetchOutputs]);

  return (
    <div className="mb-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Skills</h2>
      </div>

      <SongwriterSkillCard entityId={entityId} onSuccess={fetchOutputs} />

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 p-4">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">Recent outputs</h3>
        {loading ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : outputs.length === 0 ? (
          <p className="text-xs text-gray-500">No skill outputs yet. Use the songwriter above to generate lyrics.</p>
        ) : (
          <ul className="space-y-2">
            {outputs.map((out) => (
              <li key={out.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-potato-600 dark:text-potato-400">{out.skill_id}</span>
                  <span className="text-gray-400 mx-2">·</span>
                  <span className="text-gray-600 dark:text-gray-400 truncate block sm:inline">
                    {preview(out.text_content)}
                  </span>
                  <span className="text-gray-400 ml-2">{formatDate(out.created_at)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(out)}
                  className="shrink-0 rounded px-2 py-1 text-potato-600 dark:text-potato-400 hover:bg-potato-50 dark:hover:bg-potato-900/30"
                >
                  View
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-output-title"
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              <h3 id="skill-output-title" className="font-semibold text-potato-800 dark:text-potato-200">
                {selected.skill_id} · {formatDate(selected.created_at)}
              </h3>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              {selected.text_content ? (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200 font-sans">
                  {selected.text_content}
                </pre>
              ) : selected.public_url ? (
                <p className="text-sm">
                  <a href={selected.public_url} target="_blank" rel="noopener noreferrer" className="text-potato-600 underline">
                    Open content
                  </a>
                </p>
              ) : (
                <p className="text-sm text-gray-500">No text content.</p>
              )}
              {selected.metadata && Object.keys(selected.metadata).length > 0 && (
                <details className="mt-4">
                  <summary className="text-xs font-medium text-gray-500 cursor-pointer">Metadata</summary>
                  <pre className="mt-2 text-xs bg-gray-100 dark:bg-gray-900 p-3 rounded overflow-x-auto">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
