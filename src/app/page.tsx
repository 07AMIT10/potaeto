import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="text-center space-y-6">
        <h1 className="text-4xl font-bold text-potato-700">Potaeto</h1>
        <p className="text-lg text-gray-600 dark:text-gray-400 max-w-md">
          Create WHO and WHAT you want to build. Describe in text or voice, then chat, generate, and share.
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/login"
            className="px-6 py-3 rounded-lg bg-potato-500 text-white font-medium hover:bg-potato-600"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="px-6 py-3 rounded-lg border border-potato-500 text-potato-700 font-medium hover:bg-potato-50"
          >
            Get started
          </Link>
        </div>
      </div>
    </main>
  );
}
