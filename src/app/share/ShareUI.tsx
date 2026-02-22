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
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return { copy, copied };
}

export function ShareUI({ entities, content }: ShareUIProps) {
  const { copy, copied } = useCopy();
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
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Entity profiles</h2>
        <p className="text-sm text-gray-500 mb-2">Share your WHO/WHAT profile. Anyone with the link can view (if public).</p>
        <ul className="space-y-2">
          {entities.map((e) => {
            const url = `${baseUrl}/e/${e.id}`;
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <span className="font-medium">{e.name}</span>
                <label className="flex items-center gap-1 text-sm">
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
                  />
                  Public
                </label>
                <code className="text-xs text-gray-500 truncate max-w-[200px]">{url}</code>
                <button
                  type="button"
                  onClick={() => copy(url)}
                  className="text-sm text-potato-600 hover:underline"
                >
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  type="button"
                  onClick={() => shareNative(url, e.name)}
                  className="text-sm text-potato-600 hover:underline"
                >
                  Share
                </button>
              </li>
            );
          })}
          {entities.length === 0 && (
            <li className="text-gray-500 text-sm">No entities yet. Create one from Onboarding.</li>
          )}
        </ul>
      </section>
      <section>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Content links</h2>
        <p className="text-sm text-gray-500 mb-2">Direct links to generated content.</p>
        <ul className="space-y-2">
          {content.filter((c) => c.public_url || c.id).map((c) => {
            const url = c.public_url ?? `${baseUrl}/c/${c.id}`;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <span className="text-gray-500 text-sm">{c.type}</span>
                <code className="text-xs truncate max-w-[240px]">{url}</code>
                <button
                  type="button"
                  onClick={() => copy(url)}
                  className="text-sm text-potato-600 hover:underline"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={() => shareNative(url, `${c.type} content`)}
                  className="text-sm text-potato-600 hover:underline"
                >
                  Share
                </button>
              </li>
            );
          })}
          {content.filter((c) => c.public_url || c.id).length === 0 && (
            <li className="text-gray-500 text-sm">No shareable content yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
