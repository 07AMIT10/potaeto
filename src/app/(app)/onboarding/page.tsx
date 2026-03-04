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
    <div className="max-w-2xl mx-auto animate-fade-in">
      <div className="text-center space-y-3 mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-potato-100 dark:bg-potato-900/30 text-3xl mb-2">
          🥔
        </div>
        <h1 className="page-title">Describe your character</h1>
        <p className="text-[var(--muted)] max-w-md mx-auto">
          Tell us about WHO and WHAT you want to build. Use text or voice &mdash; we&apos;ll shape it into a persona.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="card p-1">
          <div className="relative">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. A friendly chef named Mario, middle-aged, loves Italian food, tells stories while cooking, warm and humorous..."
              rows={5}
              required
              className="w-full rounded-xl border-0 bg-transparent p-4 pr-14 text-[var(--foreground)] resize-y focus:outline-none focus:ring-0 placeholder:text-[var(--muted)]"
            />
            <div className="absolute right-3 bottom-3">
              <VoiceInput
                onTranscript={(t) => setText((prev) => (prev ? prev + ' ' + t : t))}
                disabled={loading}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="card border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300 animate-fade-in">
            {error}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <button type="submit" disabled={loading || !text.trim()} className="btn-primary flex-1">
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Creating...
              </span>
            ) : (
              'Create my character'
            )}
          </button>
          <Link href="/create" className="btn-secondary text-center">
            Skip &mdash; create manually
          </Link>
        </div>
      </form>
    </div>
  );
}
