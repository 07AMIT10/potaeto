'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * The Supabase-era login flow is retired in Release 1: a device pair is the
 * only identity. Keep the route alive so old bookmarks land on `/pair` rather
 * than a dead page (and never call the parked `/api/*` handlers again).
 */
export default function LoginPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/pair');
  }, [router]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <p className="text-[var(--muted)]">
        Device login has moved to pairing.{' '}
        <Link href="/pair" className="text-potato-600 hover:underline">
          Continue to /pair
        </Link>
      </p>
    </main>
  );
}
