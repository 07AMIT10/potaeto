'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding` },
    });
    setLoading(false);
    if (error) {
      setMessage({ type: 'error', text: error.message });
      return;
    }
    setMessage({ type: 'success', text: 'Check your email for the login link.' });
  };

  const handleOAuth = async (provider: 'google') => {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/onboarding` },
    });
    setLoading(false);
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-potato-700">Potaeto</h1>
          <p className="text-sm text-gray-500 mt-1">Log in to create your WHO/WHAT</p>
        </div>

        <form onSubmit={handleMagicLink} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="mt-1 block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-potato-500 py-2 px-4 font-medium text-white hover:bg-potato-600 disabled:opacity-50"
          >
            {loading ? 'Sending…' : 'Send magic link'}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-gray-300 dark:border-gray-600" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-[var(--background)] px-2 text-gray-500">or</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => handleOAuth('google')}
          disabled={loading}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 py-2 px-4 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          Continue with Google
        </button>

        {message && (
          <p
            className={`text-sm ${
              message.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {message.text}
          </p>
        )}

        <p className="text-center text-sm text-gray-500">
          <Link href="/" className="text-potato-600 hover:underline">
            Back home
          </Link>
        </p>
      </div>
    </main>
  );
}
