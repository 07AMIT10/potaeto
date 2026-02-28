'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

interface Message {
  role: 'user' | 'model';
  parts: string;
}

interface ChatUIProps {
  entityId: string;
  entityName: string;
}

export function ChatUI({ entityId, entityName }: ChatUIProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/conversations/${entityId}/messages`);
        const data = await res.json();
        if (!res.ok) return;
        if (cancelled) return;
        const loaded: Message[] = (data.messages ?? []).map((m: { role: string; content: string }) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: m.content,
        }));
        setMessages(loaded);
      } finally {
        if (!cancelled) setInitialLoading(false);
        setTimeout(scrollToBottom, 50);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, scrollToBottom]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: Message = { role: 'user', parts: text };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    scrollToBottom();

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId,
          message: text,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMessages((m) => [...m, { role: 'model', parts: `Error: ${err.error ?? res.statusText}` }]);
        setLoading(false);
        return;
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let full = '';
      setMessages((m) => [...m, { role: 'model', parts: '' }]);

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
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', parts: `Error: ${String(e)}` }]);
    }
    setLoading(false);
  };

  return (
    <div className="flex-1 flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {initialLoading && (
          <p className="text-gray-500 text-sm">Loading conversation…</p>
        )}
        {!initialLoading && messages.length === 0 && (
          <p className="text-gray-500 text-sm">Chat with {entityName}. Send a message below.</p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={
              msg.role === 'user'
                ? 'ml-auto max-w-[85%] rounded-lg bg-potato-100 dark:bg-potato-900/50 px-3 py-2'
                : 'mr-auto max-w-[85%] rounded-lg bg-gray-100 dark:bg-gray-700 px-3 py-2'
            }
          >
            <p className="text-sm whitespace-pre-wrap">{msg.parts || '...'}</p>
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role === 'model' && !messages[messages.length - 1].parts && (
          <div className="mr-auto rounded-lg bg-gray-100 dark:bg-gray-700 px-3 py-2">
            <span className="animate-pulse">Thinking...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <form
        className="p-3 border-t border-gray-200 dark:border-gray-700 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message..."
          disabled={loading}
          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg bg-potato-500 px-4 py-2 text-sm font-medium text-white hover:bg-potato-600 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
