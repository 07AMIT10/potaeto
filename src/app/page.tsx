import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-6 py-4 max-w-5xl mx-auto w-full">
        <span className="text-xl font-bold text-potato-600">Potaeto</span>
        <Link href="/pair" className="btn-ghost text-potato-600">
          Pair device
        </Link>
      </nav>

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-20">
        <div className="text-center space-y-8 max-w-2xl animate-fade-in">
          <div className="inline-flex items-center gap-2 rounded-full bg-potato-100 dark:bg-potato-900/30 px-4 py-1.5 text-sm font-medium text-potato-700 dark:text-potato-300">
            <span className="w-2 h-2 rounded-full bg-potato-500 animate-pulse" />
            MVP Preview
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-balance leading-[1.1]">
            One agent.
            <span className="text-potato-500 block">Always on.</span>
          </h1>

          <p className="text-lg text-[var(--muted)] max-w-lg mx-auto text-balance leading-relaxed">
            Potaeto remembers what matters, runs on your own machine, and is
            reachable from the browser or Telegram. Pair this device to start
            chatting.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Link href="/pair" className="btn-primary text-base px-8 py-3">
              Pair this device
            </Link>
            <Link href="/chat" className="btn-secondary text-base px-8 py-3">
              Open chat
            </Link>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-8 max-w-lg mx-auto">
            {[
              { icon: '💬', label: 'Chat', href: '/chat' },
              { icon: '🧠', label: 'Memory', href: '/memory' },
              { icon: '⏰', label: 'Schedules', href: null },
              { icon: '📈', label: 'Monitor', href: null },
            ].map((f) => {
              const content = (
                <>
                  <span className="text-2xl block mb-1">{f.icon}</span>
                  <span className="text-xs font-medium text-[var(--muted)]">{f.label}</span>
                </>
              );
              return f.href ? (
                <Link
                  key={f.label}
                  href={f.href}
                  className="card p-3 text-center transition-all hover:border-potato-300 dark:hover:border-potato-700 hover:shadow-sm"
                >
                  {content}
                </Link>
              ) : (
                <div key={f.label} className="card p-3 text-center">
                  {content}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <footer className="text-center py-6 text-xs text-[var(--muted)]">
        Potaeto Release 1 — one persona, one shared conversation
      </footer>
    </main>
  );
}
