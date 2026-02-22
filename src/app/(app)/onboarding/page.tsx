'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const VoiceInput = dynamic(
  () => import('@/components/VoiceInput').then((m) => ({ default: m.VoiceInput })),
  { ssr: false }
);

export default function OnboardingPage() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/parse-entity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong');
        setLoading(false);
        return;
      }
      router.push(`/create?entity=${data.id}`);
    } catch {
      setError('Network error');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-potato-800">Describe WHO and WHAT you want to build</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Use text or voice. We&apos;ll create a character/persona with characteristics, appearance, persona, skills, and attributes.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="relative">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. A friendly chef named Mario, middle-aged, loves Italian food, tells stories while cooking, warm and humorous..."
            rows={6}
            required
            className="w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-4 pr-14 text-gray-900 dark:text-gray-100 resize-y"
          />
          <div className="absolute right-3 bottom-3">
            <VoiceInput
              onTranscript={(t) => setText((prev) => (prev ? prev + ' ' + t : t))}
              disabled={loading}
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading || !text.trim()}
            className="rounded-lg bg-potato-500 px-6 py-2.5 font-medium text-white hover:bg-potato-600 disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Create my WHO/WHAT'}
          </button>
          <Link
            href="/create"
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-6 py-2.5 font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Skip (create manually)
          </Link>
        </div>
      </form>
    </div>
  );
}
