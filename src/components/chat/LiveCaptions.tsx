'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';

export interface LiveCaptionsProps {
  text: string;
  isStreaming?: boolean;
  isSpeaking?: boolean;
  onOpenChat?: () => void;
  className?: string;
}

export function LiveCaptions({
  text,
  isStreaming = false,
  isSpeaking = false,
  onOpenChat,
  className = '',
}: LiveCaptionsProps) {
  // Toggle for [🗣️ Spell-out Speech], persisted to localStorage 'potaeto_spell_out' (default true)
  const [spellOut, setSpellOut] = useState<boolean>(true);
  const [activeWordIndex, setActiveWordIndex] = useState<number>(0);
  const [copied, setCopied] = useState<boolean>(false);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load persisted spell-out preference on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('potaeto_spell_out');
      if (stored !== null) {
        setSpellOut(stored !== 'false');
      }
    } catch {
      // Ignore localStorage access restrictions
    }
  }, []);

  const toggleSpellOut = useCallback(() => {
    setSpellOut((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('potaeto_spell_out', String(next));
      } catch {
        // Fallback
      }
      return next;
    });
  }, []);

  // Split text into words
  const words = useMemo(() => {
    return text.trim().split(/\s+/).filter(Boolean);
  }, [text]);

  // Handle word-by-word typewriter/karaoke progression
  useEffect(() => {
    if (!spellOut) {
      setActiveWordIndex(words.length > 0 ? words.length - 1 : 0);
      return;
    }

    if (words.length === 0) {
      setActiveWordIndex(0);
      return;
    }

    // Step through words with a cadence matching speech (~75ms per word)
    const interval = setInterval(() => {
      setActiveWordIndex((current) => {
        if (current < words.length - 1) {
          return current + 1;
        }
        return current;
      });
    }, 75);

    return () => clearInterval(interval);
  }, [words.length, spellOut, text]);

  // Reset activeWordIndex when a brand new text arrives
  const prevTextRef = useRef(text);
  useEffect(() => {
    if (text && !text.startsWith(prevTextRef.current.slice(0, 15))) {
      setActiveWordIndex(0);
    }
    prevTextRef.current = text;
  }, [text]);

  // Tap card to copy
  const handleCopy = useCallback(async () => {
    if (!text.trim()) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 1800);
    } catch {
      // Ignore clipboard error
    }
  }, [text]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  if (!text.trim() && !isStreaming && !isSpeaking) {
    return null;
  }

  const isLive = isStreaming || isSpeaking;

  return (
    <div
      role="region"
      aria-label="Live Speech Captions"
      className={`relative w-full max-w-xl mx-auto rounded-2xl bg-[var(--card-bg)]/90 backdrop-blur-md border border-[var(--card-border)]/70 shadow-lg transition-all duration-300 ${className}`}
    >
      {/* Top Header Bar */}
      <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-[var(--card-border)]/40 text-xs">
        <div className="flex items-center gap-2">
          {isLive ? (
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              {isSpeaking ? 'Speaking' : 'Generating'}
            </span>
          ) : (
            <span className="text-[var(--muted)] flex items-center gap-1 font-medium">
              <span>💬</span> Live Captions
            </span>
          )}

          {copied && (
            <span className="text-potato-600 dark:text-potato-400 font-medium text-[11px] animate-fade-in">
              Copied to clipboard!
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Toggle [🗣️ Spell-out Speech] */}
          <button
            type="button"
            onClick={toggleSpellOut}
            aria-label="Toggle spell-out speech"
            title={spellOut ? 'Disable spell-out animation' : 'Enable spell-out animation'}
            className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
              spellOut
                ? 'bg-potato-100 dark:bg-potato-950/60 text-potato-700 dark:text-potato-300 border border-potato-300/40'
                : 'text-[var(--muted)] hover:bg-[var(--card-border)]/30'
            }`}
          >
            🗣️ Spell-out Speech {spellOut ? 'ON' : 'OFF'}
          </button>

          {/* Copy Button */}
          <button
            type="button"
            onClick={handleCopy}
            className="btn-ghost p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            title="Copy captions text"
            aria-label="Copy captions text"
          >
            📋
          </button>

          {/* Open full chat button */}
          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              className="btn-ghost px-2 py-0.5 text-[11px] text-potato-600 hover:text-potato-700 font-medium"
              title="Open full chat"
              aria-label="Open full chat"
            >
              Full Chat ↗
            </button>
          )}
        </div>
      </div>

      {/* Captions Text Container (click to copy) */}
      <div
        onClick={handleCopy}
        className="p-3.5 sm:p-4 text-sm sm:text-base leading-relaxed cursor-pointer select-text hover:bg-[var(--card-border)]/10 transition-colors rounded-b-2xl"
        title="Click to copy text"
      >
        {words.length === 0 ? (
          <span className="text-[var(--muted)] italic">...</span>
        ) : (
          <p
            data-testid="live-captions-text"
            aria-label={text}
            className="flex flex-wrap items-baseline m-0"
          >
            {words.map((word, idx) => {
              const isCurrent = spellOut && isLive && idx === activeWordIndex;
              const isPast = !spellOut || idx <= activeWordIndex || !isLive;

              return (
                <span
                  key={`${idx}-${word}`}
                  className={`inline-block mr-1.5 transition-all duration-100 ${
                    isCurrent
                      ? 'font-bold text-potato-700 dark:text-potato-200 bg-potato-500/20 px-1 py-0.5 rounded shadow-xs scale-105'
                      : isPast
                        ? 'text-[var(--foreground)]'
                        : 'text-[var(--muted)] opacity-35'
                  }`}
                >
                  {word}{' '}
                </span>
              );
            })}
          </p>
        )}
      </div>
    </div>
  );
}
