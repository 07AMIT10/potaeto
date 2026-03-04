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
  if (!text) return '\u2014';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen) + '\u2026';
}

export function SkillsSection({ entityId }: SkillsSectionProps) {
  const [outputs, setOutputs] = useState<SkillOutputRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SkillOutputRow | null>(null);
  const [expanded, setExpanded] = useState(false);

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
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left py-2 group"
      >
        <svg
          className={`w-3.5 h-3.5 text-[var(--muted)] transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-sm font-semibold">Skills</span>
        {outputs.length > 0 && (
          <span className="text-xs text-[var(--muted)] bg-potato-100 dark:bg-potato-900/30 px-2 py-0.5 rounded-full">
            {outputs.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 mt-2 animate-slide-up">
          <SongwriterSkillCard entityId={entityId} onSuccess={fetchOutputs} />

          {(loading || outputs.length > 0) && (
            <div className="card p-4">
              <h3 className="text-xs font-medium text-[var(--muted)] mb-3 uppercase tracking-wide">Recent outputs</h3>
              {loading ? (
                <div className="flex gap-1.5 py-2">
                  <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '150ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '300ms' }} />
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {outputs.map((out) => (
                    <li key={out.id} className="flex items-center justify-between gap-2 rounded-lg p-2 hover:bg-potato-50 dark:hover:bg-potato-900/20 transition-colors">
                      <div className="min-w-0 flex-1 flex items-center gap-2 text-xs">
                        <span className="font-medium text-potato-600 dark:text-potato-400 shrink-0">{out.skill_id}</span>
                        <span className="text-[var(--muted)] truncate">{preview(out.text_content)}</span>
                        <span className="text-[var(--muted)] shrink-0 hidden sm:inline">{formatDate(out.created_at)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelected(out)}
                        className="shrink-0 btn-ghost text-xs text-potato-600 dark:text-potato-400 px-2 py-1"
                      >
                        View
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-output-title"
        >
          <div
            className="bg-[var(--card)] rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col border border-[var(--card-border)] animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-[var(--card-border)]">
              <h3 id="skill-output-title" className="font-semibold">
                {selected.skill_id} &middot; {formatDate(selected.created_at)}
              </h3>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="btn-ghost p-2"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 scrollbar-thin">
              {selected.text_content ? (
                <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
                  {selected.text_content}
                </pre>
              ) : selected.public_url ? (
                <p className="text-sm">
                  <a href={selected.public_url} target="_blank" rel="noopener noreferrer" className="text-potato-600 underline">
                    Open content
                  </a>
                </p>
              ) : (
                <p className="text-sm text-[var(--muted)]">No text content.</p>
              )}
              {selected.metadata && Object.keys(selected.metadata).length > 0 && (
                <details className="mt-4">
                  <summary className="text-xs font-medium text-[var(--muted)] cursor-pointer hover:text-potato-600 transition-colors">Metadata</summary>
                  <pre className="mt-2 text-xs bg-black/5 dark:bg-white/5 p-3 rounded-xl overflow-x-auto">
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
