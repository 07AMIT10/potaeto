'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { coreBaseUrl } from '@/components/providers/CoreProvider';
import { StorageStatus } from '@/components/storage/StorageStatus';

/**
 * Device pairing: exchange the server-printed single-use code for an HttpOnly
 * device cookie. `POST /v1/auth/pair` sets the cookie itself; the browser never
 * sees a long-lived bearer token.
 */
export default function PairPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !deviceName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const baseUrl = coreBaseUrl();
      const response = await fetch(`${baseUrl}/v1/auth/pair`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          device_name: deviceName.trim(),
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? 'That pairing code is invalid or has expired. Create a new code and try again.'
            : `Pairing failed (HTTP ${response.status}). Please try again.`,
        );
        return;
      }
      if (typeof response.json === 'function') {
        const data = await response.json().catch(() => null);
        if (data?.token && typeof window !== 'undefined') {
          localStorage.setItem('potaeto_device_token', data.token);
        }
      }
      router.push('/chat');
    } catch {
      setError('Could not reach the Potaeto core. Check the connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8 animate-fade-in">
        <div className="text-center space-y-2">
          <Link href="/" className="text-3xl font-bold text-potato-600 inline-block">
            Potaeto
          </Link>
          <h1 className="text-xl font-semibold">Pair this device</h1>
          <p className="text-sm text-[var(--muted)]">
            Create a code on the server with{' '}
            <code className="text-xs">python -m app.cli pair</code>, then enter it
            here. Codes are single-use and expire after five minutes.
          </p>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4">
          <div>
            <label htmlFor="code" className="label">
              Pairing code
            </label>
            <input
              id="code"
              name="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              required
              className="input-field"
              placeholder="32-character code"
            />
          </div>
          <div>
            <label htmlFor="device_name" className="label">
              Device name
            </label>
            <input
              id="device_name"
              name="device_name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              required
              className="input-field"
              placeholder="phone, laptop, …"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="card border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !code.trim() || !deviceName.trim()}
            className="btn-primary w-full"
          >
            {loading ? 'Pairing…' : 'Pair device'}
          </button>
        </form>

        <section aria-labelledby="storage-sync-heading" className="card p-6 space-y-4">
          <h2 id="storage-sync-heading" className="text-base font-semibold">
            Storage &amp; Sync
          </h2>
          <StorageStatus />
        </section>

        <p className="text-center text-sm text-[var(--muted)]">
          <Link href="/" className="text-potato-600 hover:underline">
            Back home
          </Link>
        </p>
      </div>
    </main>
  );
}
