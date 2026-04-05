'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuthMode } from '@/lib/auth/useAuthMode';
import { loadGuestChat, saveGuestChat, type GuestChatMessage } from '@/lib/guestStorage';
import { AvatarFace } from '@/components/AvatarFace';
import { MessageContent } from '@/components/MessageContent';
import { useExpression } from '@/lib/expressions/useExpression';
import type { AvatarTemplateId } from '@/lib/avatar/template';

interface Message {
  role: 'user' | 'model';
  parts: string;
  proactive?: boolean;
}

interface ChatUIProps {
  entityId: string;
  entityName: string;
  avatarTemplate?: AvatarTemplateId;
}

export function ChatUI({ entityId, entityName, avatarTemplate = 'potato' }: ChatUIProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const auth = useAuthMode();

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (auth.mode === 'guest') {
          const loadedGuest: GuestChatMessage[] = loadGuestChat(entityId);
          if (cancelled) return;
          const mapped: Message[] = loadedGuest.map((m) => ({
            role: m.role,
            parts: m.parts,
          }));
          setMessages(mapped);
        } else {
          const res = await fetch(`/api/conversations/${entityId}/messages`);
          const data = await res.json();
          if (!res.ok || cancelled) return;
          const loaded: Message[] = (data.messages ?? []).map(
            (m: { role: string; content: string; meta?: { proactive?: boolean } }) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: m.content,
              proactive: m.meta?.proactive ?? false,
            })
          );
          setMessages(loaded);
        }
      } finally {
        if (!cancelled) setInitialLoading(false);
        setTimeout(scrollToBottom, 50);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.mode, entityId, scrollToBottom]);

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
      if (auth.mode === 'guest') {
        const historyPayload: GuestChatMessage[] = messages.map((m) => ({
          role: m.role,
          parts: m.parts,
        }));
        const res = await fetch('/api/guest/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entityName,
            message: text,
            history: historyPayload.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts })),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setMessages((m) => [
            ...m,
            { role: 'model', parts: `Error: ${(err as { error?: string }).error ?? res.statusText}` },
          ]);
          setLoading(false);
          return;
        }
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
        setLoading(false);
        const finalMessages: Message[] = [];
        setMessages((m) => {
          finalMessages.push(...m);
          return m;
        });
        const toStore: GuestChatMessage[] = finalMessages.map((m) => ({
          role: m.role,
          parts: m.parts,
        }));
        saveGuestChat(entityId, toStore);
        inputRef.current?.focus();
        return;
      }

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, message: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMessages((m) => [
          ...m,
          { role: 'model', parts: `Error: ${(err as { error?: string }).error ?? res.statusText}` },
        ]);
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

  const latestAssistantText = messages.length > 0 && messages[messages.length - 1].role === 'model'
    ? messages[messages.length - 1].parts
    : '';
  const expression = useExpression(latestAssistantText, streaming);

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
            <AvatarFace template={avatarTemplate} expression="idle" size={56} className="mb-4 animate-potato-appear" />
            <p className="text-sm text-[var(--muted)] max-w-xs">
              Start a conversation with {entityName}. They&apos;ll stay in character.
            </p>
          </div>
        )}

        {messages.map((msg, i) => {
          const isLastAssistant = msg.role === 'model' && i === messages.length - 1;
          const isAssistant = msg.role === 'model';

          return (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
            >
              {isAssistant && (
                <div className="flex-shrink-0 mr-2 self-end mb-1">
                  {isLastAssistant ? (
                    <AvatarFace
                      template={avatarTemplate}
                      expression={expression.state}
                      intensity={expression.intensity}
                      size={32}
                    />
                  ) : (
                    <AvatarFace template={avatarTemplate} expression="idle" size={32} className="opacity-50" />
                  )}
                </div>
              )}
              <div className={`max-w-[75%] sm:max-w-[65%] ${
                msg.role === 'user'
                  ? 'rounded-2xl rounded-br-md bg-potato-500 text-white px-4 py-2.5'
                  : 'rounded-2xl rounded-bl-md bg-[var(--card)] border border-[var(--card-border)] px-4 py-2.5'
              }`}>
                {msg.proactive && isAssistant && (
                  <span className="inline-block text-[10px] font-medium text-potato-500 mb-1 uppercase tracking-wide">
                    {entityName} reached out
                  </span>
                )}
                <MessageContent text={msg.parts} isAssistant={isAssistant} />
              </div>
            </div>
          );
        })}

        {loading && streaming && messages[messages.length - 1]?.role === 'model' && messages[messages.length - 1].parts && (
          <div className="flex justify-start pl-10">
            <span className="inline-block w-1.5 h-4 bg-potato-400 rounded-full animate-pulse" />
          </div>
        )}

        {loading && !streaming && (
          <div className="flex justify-start animate-fade-in">
            <div className="flex-shrink-0 mr-2 self-end mb-1">
              <AvatarFace template={avatarTemplate} expression="idle" size={32} className="opacity-70" />
            </div>
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
