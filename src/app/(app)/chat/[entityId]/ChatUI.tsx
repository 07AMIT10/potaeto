'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

interface Message {
  role: 'user' | 'model';
  parts: string;
  proactive?: boolean;
}

interface ChatUIProps {
  entityId: string;
  entityName: string;
}

export function ChatUI({ entityId, entityName }: ChatUIProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/conversations/${entityId}/messages`);
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const loaded: Message[] = (data.messages ?? []).map((m: { role: string; content: string; meta?: { proactive?: boolean } }) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: m.content,
          proactive: m.meta?.proactive ?? false,
        }));
        setMessages(loaded);
      } finally {
        if (!cancelled) setInitialLoading(false);
        setTimeout(scrollToBottom, 50);
      }
    })();
    return () => { cancelled = true; };
  }, [entityId, scrollToBottom]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: Message = { role: 'user', parts: text };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    setStreaming(false);
    scrollToBottom();

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, message: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMessages((m) => [...m, { role: 'model', parts: `Error: ${(err as { error?: string }).error ?? res.statusText}` }]);
        setLoading(false);
        return;
      }
      const conversationId = res.headers.get('X-Conversation-Id') ?? '';
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let full = '';
      setMessages((m) => [...m, { role: 'model', parts: '' }]);
      setStreaming(true);

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          full += chunk;
          setMessages((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last.role === 'model') next[next.length - 1] = { ...last, parts: full };
            return next;
          });
          scrollToBottom();
        }
      }
      setStreaming(false);

      if (conversationId && full.trim()) {
        fetch('/api/ai/chat/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entityId, conversationId, content: full.trim() }),
        }).catch(() => {});
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', parts: `Error: ${String(e)}` }]);
    }
    setLoading(false);
    setStreaming(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex-1 flex flex-col card overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 scrollbar-thin">
        {initialLoading && (
          <div className="flex justify-center py-8">
            <div className="flex gap-1.5">
              <span className="typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="typing-dot" style={{ animationDelay: '150ms' }} />
              <span className="typing-dot" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {!initialLoading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-14 h-14 rounded-full bg-potato-100 dark:bg-potato-900/30 flex items-center justify-center text-2xl mb-4">
              {entityName.charAt(0).toUpperCase()}
            </div>
            <p className="text-sm text-[var(--muted)] max-w-xs">
              Start a conversation with {entityName}. They&apos;ll stay in character.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
          >
            <div className={`max-w-[80%] sm:max-w-[70%] ${
              msg.role === 'user'
                ? 'rounded-2xl rounded-br-md bg-potato-500 text-white px-4 py-2.5'
                : 'rounded-2xl rounded-bl-md bg-[var(--card)] border border-[var(--card-border)] px-4 py-2.5'
            }`}>
              {msg.proactive && msg.role === 'model' && (
                <span className="inline-block text-[10px] font-medium text-potato-500 mb-1 uppercase tracking-wide">
                  {entityName} reached out
                </span>
              )}
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.parts || '\u200B'}</p>
            </div>
          </div>
        ))}

        {loading && streaming && messages[messages.length - 1]?.role === 'model' && messages[messages.length - 1].parts && (
          <div className="flex justify-start pl-2">
            <span className="inline-block w-1.5 h-4 bg-potato-400 rounded-full animate-pulse" />
          </div>
        )}

        {loading && !streaming && (
          <div className="flex justify-start animate-fade-in">
            <div className="rounded-2xl rounded-bl-md bg-[var(--card)] border border-[var(--card-border)] px-4 py-3">
              <div className="flex gap-1.5">
                <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                <span className="typing-dot" style={{ animationDelay: '150ms' }} />
                <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form
        className="p-3 sm:p-4 border-t border-[var(--card-border)] flex gap-2"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Message ${entityName}...`}
          disabled={loading}
          className="input-field flex-1"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="btn-primary px-4"
          aria-label="Send"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
          </svg>
        </button>
      </form>
    </div>
  );
}
