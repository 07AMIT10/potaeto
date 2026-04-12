'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { ChatMessage } from '@/components/chat/ChatBase';

// ---------------------------------------------------------------------------
// In-conversation text search.
// Client-side substring match with highlight.
// ---------------------------------------------------------------------------

interface ChatSearchProps {
  messages: ChatMessage[];
  onScrollToMessage: (index: number) => void;
}

interface SearchResult {
  messageIndex: number;
  preview: string;
  role: 'user' | 'model';
}

function highlightMatch(text: string, query: string): string {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  // Return a window around the match.
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + query.length + 30);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

export function ChatSearch({ messages, onScrollToMessage }: ChatSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opening.
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Search on query change.
  const search = useCallback((q: string) => {
    setQuery(q);
    if (!q.trim() || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const lower = q.toLowerCase();
    const hits: SearchResult[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].parts.toLowerCase().includes(lower)) {
        hits.push({
          messageIndex: i,
          preview: highlightMatch(messages[i].parts, q),
          role: messages[i].role,
        });
      }
    }
    setResults(hits);
  }, [messages]);

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="btn-ghost p-2 text-[var(--muted)]"
        aria-label="Search messages"
        title="Search messages"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder="Search messages..."
          className="input-field text-sm py-1.5 flex-1"
        />
        <button
          type="button"
          onClick={() => { setIsOpen(false); setQuery(''); setResults([]); }}
          className="btn-ghost p-1.5 text-[var(--muted)]"
          aria-label="Close search"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Results dropdown */}
      {results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--card)] border border-[var(--card-border)] rounded-xl shadow-xl z-20 max-h-48 overflow-y-auto scrollbar-thin animate-fade-in">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onScrollToMessage(r.messageIndex);
                setIsOpen(false);
                setQuery('');
                setResults([]);
              }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-potato-50 dark:hover:bg-potato-900/20 transition-colors border-b last:border-b-0 border-[var(--card-border)]"
            >
              <span className="font-medium text-potato-600 dark:text-potato-400">
                {r.role === 'user' ? 'You' : 'Entity'}
              </span>
              <span className="text-[var(--muted)] ml-1 truncate">{r.preview}</span>
            </button>
          ))}
          <div className="text-[10px] text-[var(--muted)] px-3 py-1.5">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {query.length >= 2 && results.length === 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--card)] border border-[var(--card-border)] rounded-xl shadow-xl z-20 px-3 py-3 text-xs text-[var(--muted)] text-center animate-fade-in">
          No messages found
        </div>
      )}
    </div>
  );
}
