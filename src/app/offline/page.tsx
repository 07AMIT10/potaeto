import Link from 'next/link';

export default function OfflinePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <span className="text-5xl mb-4" aria-hidden>
        🥔
      </span>
      <h1 className="text-2xl font-bold text-potato-600">You&apos;re offline</h1>
      <p className="mt-2 max-w-sm text-[var(--muted)]">
        Potaeto can&apos;t reach the server right now. Your messages are saved on
        this device and will sync when you reconnect.
      </p>
      <Link href="/" className="btn-primary mt-6 px-6 py-3">
        Try again
      </Link>
    </main>
  );
}
