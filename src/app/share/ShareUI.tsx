'use client';

import { useState } from 'react';

interface EntityRow {
  id: string;
  name: string;
  slug: string;
  is_public: boolean;
}

interface ContentRow {
  id: string;
  type: string;
  public_url: string | null;
  created_at: string;
}

interface ShareUIProps {
  entities: EntityRow[];
  content: ContentRow[];
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };
  return { copy, copiedUrl: copied };
}

export function ShareUI({ entities, content }: ShareUIProps) {
  const { copy, copiedUrl } = useCopy();
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const shareNative = async (url: string, title: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ url, title });
      } catch {
        copy(url);
      }
    } else {
      copy(url);
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="section-title text-base">Entity profiles</h2>
        <p className="text-sm text-[var(--muted)]">Share your characters. Anyone with the link can view if public.</p>
        {entities.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-[var(--muted)] text-sm">No entities yet. Create one from Onboarding.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {entities.map((e) => {
              const url = `${baseUrl}/e/${e.id}`;
              return (
                <div key={e.id} className="card p-4 flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-potato-100 dark:bg-potato-900/30 flex items-center justify-center text-sm font-medium shrink-0">
                      {e.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium text-sm truncate">{e.name}</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={e.is_public}
                      onChange={async () => {
                        await fetch(`/api/entities/${e.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ is_public: !e.is_public }),
                        });
                        window.location.reload();
                      }}
                      className="rounded border-[var(--card-border)] text-potato-500 focus:ring-potato-400"
                    />
                    Public
                  </label>
                  <button type="button" onClick={() => copy(url)} className="btn-ghost text-xs text-potato-600 px-3 py-1.5">
                    {copiedUrl === url ? 'Copied!' : 'Copy link'}
                  </button>
                  <button type="button" onClick={() => shareNative(url, e.name)} className="btn-ghost text-xs text-potato-600 px-3 py-1.5">
                    Share
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="section-title text-base">Content links</h2>
        <p className="text-sm text-[var(--muted)]">Direct links to generated content.</p>
        {content.filter((c) => c.public_url || c.id).length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-[var(--muted)] text-sm">No shareable content yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {content.filter((c) => c.public_url || c.id).map((c) => {
              const url = c.public_url ?? `${baseUrl}/c/${c.id}`;
              return (
                <div key={c.id} className="card p-4 flex flex-wrap items-center gap-3">
                  <span className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide shrink-0">{c.type}</span>
                  <code className="text-xs truncate max-w-[200px] sm:max-w-[300px] text-[var(--muted)]">{url}</code>
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={() => copy(url)} className="btn-ghost text-xs text-potato-600 px-3 py-1.5">
                      {copiedUrl === url ? 'Copied!' : 'Copy'}
                    </button>
                    <button type="button" onClick={() => shareNative(url, `${c.type} content`)} className="btn-ghost text-xs text-potato-600 px-3 py-1.5">
                      Share
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
