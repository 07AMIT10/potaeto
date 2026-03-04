import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-6 py-4 max-w-5xl mx-auto w-full">
        <span className="text-xl font-bold text-potato-600">Potaeto</span>
        <Link
          href="/login"
          className="btn-ghost text-potato-600"
        >
          Log in
        </Link>
      </nav>

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-20">
        <div className="text-center space-y-8 max-w-2xl animate-fade-in">
          <div className="inline-flex items-center gap-2 rounded-full bg-potato-100 dark:bg-potato-900/30 px-4 py-1.5 text-sm font-medium text-potato-700 dark:text-potato-300">
            <span className="w-2 h-2 rounded-full bg-potato-500 animate-pulse" />
            MVP Preview
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-balance leading-[1.1]">
            Build your own
            <span className="text-potato-500 block">characters & personas</span>
          </h1>

          <p className="text-lg text-[var(--muted)] max-w-lg mx-auto text-balance leading-relaxed">
            Describe who you want to create using text or voice. Chat with them,
            generate content, and share with the world.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Link href="/login" className="btn-primary text-base px-8 py-3">
              Get started
            </Link>
            <Link href="/login" className="btn-secondary text-base px-8 py-3">
              Learn more
            </Link>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-8 max-w-lg mx-auto">
            {[
              { icon: '💬', label: 'Chat' },
              { icon: '🎨', label: 'Generate' },
              { icon: '🎤', label: 'Voice' },
              { icon: '🔗', label: 'Share' },
            ].map((f) => (
              <div key={f.label} className="card p-3 text-center">
                <span className="text-2xl block mb-1">{f.icon}</span>
                <span className="text-xs font-medium text-[var(--muted)]">{f.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="text-center py-6 text-xs text-[var(--muted)]">
        Built with Next.js, Supabase & Gemini
      </footer>
    </main>
  );
}
