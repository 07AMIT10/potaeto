'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Release 1 ships one seeded persona; character creation is retired from the
 * live tree. Old `/onboarding` links land on device pairing instead of calling
 * the parked `legacy/next-app/api/*` handlers.
 */
export default function OnboardingPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/pair');
  }, [router]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <p className="text-[var(--muted)]">
        Onboarding is replaced by one seeded agent. Pair this device to begin.{' '}
        <Link href="/pair" className="text-potato-600 hover:underline">
          Continue to /pair
        </Link>
      </p>
    </main>
  );
}
