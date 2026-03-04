'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

interface EntityRow {
  id: string;
  name: string;
  slug: string;
}

interface ContentRow {
  id: string;
  type: string;
  public_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  entity_id: string | null;
}

interface LibraryContentProps {
  entities: EntityRow[];
  content: ContentRow[];
}

export function LibraryContent({ entities, content }: LibraryContentProps) {
  const [selectedEntity, setSelectedEntity] = useState<string>('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [textPrompt, setTextPrompt] = useState('');
  const [imageLoading, setImageLoading] = useState(false);
  const [textLoading, setTextLoading] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [generatedText, setGeneratedText] = useState<string | null>(null);

  const generateImage = async () => {
    if (!imagePrompt.trim()) return;
    setImageLoading(true);
    setGeneratedImageUrl(null);
    try {
      const res = await fetch('/api/ai/generate/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: selectedEntity || undefined,
          prompt: imagePrompt,
        }),
      });
      const data = await res.json();
      if (res.ok && data.public_url) setGeneratedImageUrl(data.public_url);
    } finally {
      setImageLoading(false);
    }
  };

  const generateText = async () => {
    if (!textPrompt.trim()) return;
    setTextLoading(true);
    setGeneratedText(null);
    try {
      const res = await fetch('/api/ai/generate/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: selectedEntity || undefined,
          prompt: textPrompt,
          save: true,
        }),
      });
      const data = await res.json();
      if (res.ok && data.text) setGeneratedText(data.text);
    } finally {
      setTextLoading(false);
    }
  };

  const entitySelect = (
    <select
      value={selectedEntity}
      onChange={(e) => setSelectedEntity(e.target.value)}
      className="input-field w-auto min-w-[140px]"
    >
      <option value="">No character</option>
      {entities.map((e) => (
        <option key={e.id} value={e.id}>{e.name}</option>
      ))}
    </select>
  );

  return (
    <div className="space-y-8">
      <section className="card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold">Generate image</h2>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {entitySelect}
          <input
            type="text"
            value={imagePrompt}
            onChange={(e) => setImagePrompt(e.target.value)}
            placeholder="Describe the image..."
            className="input-field flex-1"
          />
          <button type="button" onClick={generateImage} disabled={imageLoading} className="btn-primary shrink-0">
            {imageLoading ? 'Generating...' : 'Generate'}
          </button>
        </div>
        {generatedImageUrl && (
          <div className="animate-fade-in">
            <Image src={generatedImageUrl} alt="Generated" width={320} height={320} className="rounded-xl" />
            <a href={generatedImageUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-potato-600 hover:underline mt-2 inline-block">
              Open full size
            </a>
          </div>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold">Generate text</h2>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            value={selectedEntity}
            onChange={(e) => setSelectedEntity(e.target.value)}
            className="input-field w-auto min-w-[140px]"
          >
            <option value="">No character</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={textPrompt}
            onChange={(e) => setTextPrompt(e.target.value)}
            placeholder="What should they write about?"
            className="input-field flex-1"
          />
          <button type="button" onClick={generateText} disabled={textLoading} className="btn-primary shrink-0">
            {textLoading ? 'Generating...' : 'Generate'}
          </button>
        </div>
        {generatedText && (
          <div className="rounded-xl bg-black/5 dark:bg-white/5 p-4 text-sm whitespace-pre-wrap leading-relaxed animate-fade-in">
            {generatedText}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="section-title text-base">Recent content</h2>
        {content.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-[var(--muted)] text-sm">No content yet. Generate an image or text above.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {content.map((c) => (
              <div key={c.id} className="card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide">{c.type}</span>
                  <Link href={`/c/${c.id}`} className="text-xs text-potato-600 hover:underline">
                    Share
                  </Link>
                </div>
                {c.type === 'image' && c.public_url && (
                  <Image src={c.public_url} alt="Content" width={200} height={200} className="rounded-xl w-full h-auto" />
                )}
                {c.type === 'text' && (
                  <p className="text-xs text-[var(--muted)] line-clamp-3">
                    {(c.metadata as { text?: string })?.text ?? 'Text content'}
                  </p>
                )}
                {c.public_url && (
                  <a href={c.public_url} target="_blank" rel="noopener noreferrer" className="text-xs text-potato-600 hover:underline truncate block">
                    {c.public_url}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
