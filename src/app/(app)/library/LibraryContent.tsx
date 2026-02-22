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

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Generate image</h2>
        <div className="flex flex-col sm:flex-row gap-2 mb-2">
          <select
            value={selectedEntity}
            onChange={(e) => setSelectedEntity(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          >
            <option value="">No character</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={imagePrompt}
            onChange={(e) => setImagePrompt(e.target.value)}
            placeholder="Describe the image..."
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={generateImage}
            disabled={imageLoading}
            className="rounded-lg bg-potato-500 px-4 py-2 text-sm font-medium text-white hover:bg-potato-600 disabled:opacity-50"
          >
            {imageLoading ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {generatedImageUrl && (
          <div className="mt-2">
            <Image src={generatedImageUrl} alt="Generated" width={320} height={320} className="rounded-lg" />
            <a href={generatedImageUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-potato-600 hover:underline mt-1 inline-block">
              Open / share link
            </a>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Generate text</h2>
        <div className="flex flex-col sm:flex-row gap-2 mb-2">
          <select
            value={selectedEntity}
            onChange={(e) => setSelectedEntity(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
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
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={generateText}
            disabled={textLoading}
            className="rounded-lg bg-potato-500 px-4 py-2 text-sm font-medium text-white hover:bg-potato-600 disabled:opacity-50"
          >
            {textLoading ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {generatedText && (
          <div className="mt-2 p-3 rounded-lg bg-gray-100 dark:bg-gray-700 text-sm whitespace-pre-wrap">
            {generatedText}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Recent content</h2>
        <ul className="space-y-2">
          {content.length === 0 && (
            <li className="text-gray-500 text-sm">No content yet. Generate an image or text above.</li>
          )}
          {content.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">{c.type}</span>
              {c.public_url ? (
                <a href={c.public_url} target="_blank" rel="noopener noreferrer" className="text-potato-600 hover:underline truncate max-w-xs">
                  {c.public_url}
                </a>
              ) : (
                <span className="text-gray-400">(no link)</span>
              )}
              <Link href={`/c/${c.id}`} className="text-gray-500 hover:underline">
                Share page
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
