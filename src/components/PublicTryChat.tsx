'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { loadPublicTryChat, savePublicTryChat } from '@/lib/publicTryStorage';
import type { GuestChatMessage } from '@/lib/guestStorage';
import { ChatBase, type ChatMessage } from '@/components/chat/ChatBase';
import { PUBLIC_TRY_MAX_USER_MESSAGES } from '@/lib/config';
import type { AvatarTemplateId } from '@/lib/avatar/template';

interface PublicTryChatProps {
  entityId: string;
  entityName: string;
  avatarTemplate?: AvatarTemplateId;
}

export function PublicTryChat({ entityId, entityName, avatarTemplate = 'potato' }: PublicTryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [trialExhausted, setTrialExhausted] = useState(false);
  const [latestChunkLength, setLatestChunkLength] = useState(0);

  const userTurns = messages.filter((m) => m.role === 'user').length;
  const remaining = Math.max(0, PUBLIC_TRY_MAX_USER_MESSAGES - userTurns);

  // -----------------------------------------------------------------------
  // Load from localStorage
  // -----------------------------------------------------------------------
  useEffect(() => {
    const loaded = loadPublicTryChat(entityId);
    setMessages(loaded.map((m) => ({ role: m.role, parts: m.parts })));
    if (loaded.filter((m) => m.role === 'user').length >= PUBLIC_TRY_MAX_USER_MESSAGES) {
      setTrialExhausted(true);
    }
    setInitialLoading(false);
  }, [entityId]);

  // -----------------------------------------------------------------------
  // Send
  // -----------------------------------------------------------------------
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || trialExhausted) return;
    if (userTurns >= PUBLIC_TRY_MAX_USER_MESSAGES) {
      setTrialExhausted(true);
      return;
    }

    setInput('');
    const userMsg: ChatMessage = { role: 'user', parts: text };
    const historyPayload: GuestChatMessage[] = messages.map((m) => ({
      role: m.role,
      parts: m.parts,
    }));

    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    setStreaming(false);
    setLatestChunkLength(0);

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
          setLatestChunkLength(chunk.length);
          setMessages((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last.role === 'model') next[next.length - 1] = { ...last, parts: full };
            return next;
          });
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
  }, [input, loading, trialExhausted, userTurns, messages, entityId]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
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

      <ChatBase
        messages={messages}
        entityName={entityName}
        avatarTemplate={avatarTemplate}
        loading={loading}
        streaming={streaming}
        initialLoading={initialLoading}
        latestChunkLength={latestChunkLength}
        input={input}
        onInputChange={setInput}
        onSend={send}
        inputDisabled={trialExhausted}
        inputPlaceholder={trialExhausted ? 'Preview limit reached' : `Message ${entityName}...`}
        avatarSize={28}
        minHeight="280px"
        maxHeight="420px"
        aboveInput={
          trialExhausted ? (
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
          ) : undefined
        }
        belowChat={
          <div className="flex flex-wrap gap-2 justify-center sm:justify-start">
            <Link href="/onboarding" className="btn-primary text-sm py-2 px-4">
              Create your own character
            </Link>
            <Link href="/login" className="btn-secondary text-sm py-2 px-4">
              Sign in
            </Link>
          </div>
        }
      />
    </section>
  );
}
