'use client';

import Link from 'next/link';
import { CoreProvider } from '@/components/providers/CoreProvider';
import { ArduinoPanel } from '@/components/hardware/ArduinoPanel';

function HardwareDashboardContent() {
  return (
    <main className="min-h-screen flex flex-col max-w-5xl mx-auto w-full px-3 sm:px-6 py-4 sm:py-8 pt-safe pb-safe">
      {/* Navigation Header */}
      <nav className="flex items-center justify-between pb-4 sm:pb-6 mb-4 sm:mb-6 border-b border-[var(--card-border)]">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-lg font-bold text-potato-600 hover:text-potato-700 transition-colors flex items-center gap-1.5"
          >
            <span>🥔</span>
            <span>Potaeto</span>
          </Link>
          <span className="text-[var(--muted)]">/</span>
          <h1 className="text-lg font-semibold text-[var(--foreground)]">Hardware</h1>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/chat" className="btn-secondary text-xs px-3.5 py-2">
            💬 Chat
          </Link>
          <Link href="/" className="btn-ghost text-xs px-3 py-2">
            Home
          </Link>
        </div>
      </nav>

      {/* Embedded Arduino Telemetry & LED Panel */}
      <div className="flex-1">
        <ArduinoPanel />
      </div>

      <footer className="mt-12 text-center py-4 text-xs text-[var(--muted)] border-t border-[var(--card-border)]">
        Potaeto Hardware Interface — Arduino Nano 33 BLE Sense Rev2
      </footer>
    </main>
  );
}

export default function HardwarePage() {
  return (
    <CoreProvider>
      <HardwareDashboardContent />
    </CoreProvider>
  );
}
