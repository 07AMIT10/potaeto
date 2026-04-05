'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { loadPublicTryChat, savePublicTryChat } from '@/lib/publicTryStorage';
import type { GuestChatMessage } from '@/lib/guestStorage';
import { AvatarFace } from '@/components/AvatarFace';
import { MessageContent } from '@/components/MessageContent';
import { useExpression } from '@/lib/expressions/useExpression';
import { PUBLIC_TRY_MAX_USER_MESSAGES } from '@/lib/config';
import type { AvatarTemplateId } from '@/lib/avatar/template';

interface Message {
  role: 'user' | 'model';
  parts: string;
}

interface PublicTryChatProps {
  entityId: string;
  entityName: string;
  avatarTemplate?: AvatarTemplateId;
}

export function PublicTryChat({ entityId, entityName, avatarTemplate = 'potato' }: PublicTryChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [trialExhausted, setTrialExhausted] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const userTurns = messages.filter((m) => m.role === 'user').length;
  const remaining = Math.max(0, PUBLIC_TRY_MAX_USER_MESSAGES - userTurns);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const loaded = loadPublicTryChat(entityId);
    setMessages(loaded.map((m) => ({ role: m.role, parts: m.parts })));
    if (loaded.filter((m) => m.role === 'user').length >= PUBLIC_TRY_MAX_USER_MESSAGES) {
      setTrialExhausted(true);
    }
    setInitialLoading(false);
    setTimeout(scrollToBottom, 50);
  }, [entityId, scrollToBottom]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading || trialExhausted) return;
    if (userTurns >= PUBLIC_TRY_MAX_USER_MESSAGES) {
      setTrialExhausted(true);
      return;
    }

    setInput('');
    const userMsg: Message = { role: 'user', parts: text };
    const historyPayload: GuestChatMessage[] = messages.map((m) => ({
      role: m.role,
      parts: m.parts,
    }));

    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    setStreaming(false);
    scrollToBottom();

    try {
      const res = await fetch(`/api/public/entities/${entityId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: historyPayload.map((m) => ({
            role: m.role === 'model' ? 'assistant' : 'user',
            content: m.parts,
          })),
        }),
      });

      if (res.status === 429) {
        const err = await res.json().catch(() => ({}));
        setTrialExhausted(true);
        setMessages((m) => [
          ...m,
          {
            role: 'model',
            parts: (err as { error?: string }).error ?? 'Preview limit reached — sign in to keep chatting.',
          },
        ]);
        setLoading(false);
        return;
      }

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

      setMessages((m) => {
        const toStore: GuestChatMessage[] = m.map((x) => ({
          role: x.role,
          parts: x.parts,
        }));
        savePublicTryChat(entityId, toStore);
        return m;
      });

      if (userTurns + 1 >= PUBLIC_TRY_MAX_USER_MESSAGES) {
        setTrialExhausted(true);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', parts: `Error: ${String(e)}` }]);
      setLoading(false);
      setStreaming(false);
    }
    inputRef.current?.focus();
  };

  const latestAssistantText =
    messages.length > 0 && messages[messages.length - 1].role === 'model'
      ? messages[messages.length - 1].parts
      : '';
  const expression = useExpression(latestAssistantText, streaming);

  return (
    <section className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="section-title text-base">Try {entityName}</h2>
          <p className="text-sm text-[var(--muted)]">
            No account needed — {remaining} preview {remaining === 1 ? 'message' : 'messages'} left in this browser.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--card-border)] bg-[var(--card)] overflow-hidden flex flex-col min-h-[280px] max-h-[420px]">
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2 scrollbar-thin">
          {initialLoading && (
            <div className="flex justify-center py-6">
              <div className="flex gap-1.5">
                <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                <span className="typing-dot" style={{ animationDelay: '150ms' }} />
                <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          {!initialLoading && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center px-2">
              <AvatarFace template={avatarTemplate} expression="idle" size={48} className="mb-3 animate-potato-appear" />
              <p className="text-sm text-[var(--muted)] max-w-sm">
                Say hi — see how {entityName} feels in chat. Inspired? You can build your own character on Potaeto.
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
                  <div className="flex-shrink-0 mr-2 self-end mb-0.5">
                    {isLastAssistant ? (
                      <AvatarFace
                        template={avatarTemplate}
                        expression={expression.state}
                        intensity={expression.intensity}
                        size={28}
                      />
                    ) : (
                      <AvatarFace template={avatarTemplate} expression="idle" size={28} className="opacity-45" />
                    )}
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                    msg.role === 'user'
                      ? 'rounded-br-md bg-potato-500 text-white'
                      : 'rounded-bl-md bg-black/[0.04] dark:bg-white/[0.06] border border-[var(--card-border)]'
                  }`}
                >
                  <MessageContent text={msg.parts} isAssistant={isAssistant} />
                </div>
              </div>
            );
          })}

          {loading && streaming && messages[messages.length - 1]?.role === 'model' && messages[messages.length - 1].parts && (
            <div className="flex justify-start pl-9">
              <span className="inline-block w-1.5 h-4 bg-potato-400 rounded-full animate-pulse" />
            </div>
          )}

          {loading && !streaming && (
            <div className="flex justify-start">
              <div className="flex-shrink-0 mr-2 self-end">
                <AvatarFace template={avatarTemplate} expression="idle" size={28} className="opacity-60" />
              </div>
              <div className="rounded-2xl rounded-bl-md border border-[var(--card-border)] px-3 py-2">
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
          className="p-3 border-t border-[var(--card-border)] flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {trialExhausted && (
            <p className="text-xs text-[var(--muted)] text-center">
              Preview finished.{' '}
              <Link href="/login" className="text-potato-600 dark:text-potato-400 font-medium">
                Sign in
              </Link>{' '}
              to keep the conversation, or{' '}
              <Link href="/onboarding" className="text-potato-600 dark:text-potato-400 font-medium">
                create your own character
              </Link>
              .
            </p>
          )}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={trialExhausted ? 'Preview limit reached' : `Message ${entityName}...`}
              disabled={loading || trialExhausted}
              className="input-field flex-1 text-sm py-2"
            />
            <button
              type="submit"
              disabled={loading || trialExhausted || !input.trim()}
              className="btn-primary px-4 py-2 text-sm shrink-0"
              aria-label="Send"
            >
              Send
            </button>
          </div>
        </form>
      </div>

      <div className="flex flex-wrap gap-2 justify-center sm:justify-start">
        <Link href="/onboarding" className="btn-primary text-sm py-2 px-4">
          Create your own character
        </Link>
        <Link href="/login" className="btn-secondary text-sm py-2 px-4">
          Sign in
        </Link>
      </div>
    </section>
  );
}
