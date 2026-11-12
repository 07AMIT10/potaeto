'use client';

import { useEffect, useState, useCallback } from 'react';
import { useCore } from '@/components/providers/CoreProvider';
import { ulid } from '@/lib/core/ulid';
import { ChatBase, type ChatMessage } from '@/components/chat/ChatBase';
import { QuickReplies } from '@/components/QuickReplies';
import { MoodTimeline } from '@/components/MoodTimeline';
import { ChatSearch } from '@/components/ChatSearch';
import { ChatExport } from '@/components/ChatExport';
import { ModelPicker } from '@/components/ModelPicker';
import { playMessageSend, playMessageReceive, playReaction, isSoundEnabled, setSoundEnabled } from '@/lib/chat/sounds';
import type { AvatarTemplateId } from '@/lib/avatar/template';

interface ChatUIProps {
  entityId: string;
  entityName: string;
  avatarTemplate?: AvatarTemplateId;
}

function SoundToggle() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setEnabled(isSoundEnabled());
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        const next = !enabled;
        setEnabled(next);
        setSoundEnabled(next);
      }}
      className="btn-ghost p-2 text-[var(--muted)]"
      aria-label={enabled ? 'Mute sounds' : 'Enable sounds'}
      title={enabled ? 'Mute sounds' : 'Enable sounds'}
    >
      {enabled ? (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      )}
    </button>
  );
}

export function ChatUI({ entityId, entityName, avatarTemplate = 'potato' }: ChatUIProps) {
  const { client, db, conversationId, syncVersion, online } = useCore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [latestChunkLength, setLatestChunkLength] = useState(0);
  // A message that is cached/queued but has no assistant answer yet. The
  // banner lets the user retry the turn after reconnecting instead of leaving
  // a silent gap (a full offline agent turn is out of scope for Release 1).
  const [awaitingReply, setAwaitingReply] = useState<{ text: string; clientMessageId: string } | null>(null);

  // -----------------------------------------------------------------------
  // Load history from the local IndexedDB cache
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!conversationId) {
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await db.messages
          .where('conversationId')
          .equals(conversationId)
          .sortBy('createdAt');
        if (cancelled) return;
        setMessages(
          rows.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: m.content,
          }))
        );
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, conversationId, syncVersion]);

  // -----------------------------------------------------------------------
  // Send message: persist to cache + outbox, then stream (best-effort)
  // -----------------------------------------------------------------------
  const streamTurn = useCallback(
    async (text: string, { clientMessageId, addUser }: { clientMessageId?: string; addUser: boolean }) => {
      if (!conversationId) return;

      const messageId = clientMessageId ?? ulid();
      const now = new Date().toISOString();

      if (addUser) {
        setMessages((m) => [...m, { role: 'user', parts: text }]);
      }
      playMessageSend();
      setLoading(true);
      setStreaming(false);
      setLatestChunkLength(0);

      // Offline-first: cache the user message and queue it for sync. The
      // outbox entry is removed below only if this turn actually streams.
      if (addUser) {
        await db.messages.put({ id: messageId, conversationId, role: 'user', content: text, createdAt: now });
        await db.outbox.add({
          idempotencyKey: messageId,
          entityType: 'message',
          entityId: messageId,
          baseRev: 0,
          payload: { agent_id: entityId, content: text, role: 'user', channel: 'app' },
          createdAt: now,
        });
      }

      let full = '';
      let assistantId: string | null = null;
      setMessages((m) => [...m, { role: 'model', parts: '' }]);
      setStreaming(true);

      try {
        for await (const event of client.chatStream({ conversationId, message: text, clientMessageId: messageId })) {
          if (event.type === 'token') {
            const chunk = typeof event.data.text === 'string' ? event.data.text : '';
            full += chunk;
            setLatestChunkLength(chunk.length);
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last.role === 'model') next[next.length - 1] = { ...last, parts: full };
              return next;
            });
          } else if (event.type === 'done') {
            assistantId = typeof event.data.message_id === 'string' ? event.data.message_id : null;
          } else if (event.type === 'error') {
            const message = String(event.data.message ?? event.data.code ?? 'unknown error');
            if (!full) {
              full = `Error: ${message}`;
              setMessages((m) => {
                const next = [...m];
                const last = next[next.length - 1];
                if (last.role === 'model') next[next.length - 1] = { ...last, parts: full };
                return next;
              });
            }
          }
        }

        // The turn streamed and the loop persisted the user message
        // server-side (deduped by client_message_id), so drop the outbox entry.
        await db.outbox.delete(messageId);
        if (full) {
          await db.messages.put({
            id: assistantId ?? `${messageId}:assistant`,
            conversationId,
            role: 'assistant',
            content: full,
            createdAt: new Date().toISOString(),
          });
        }
        setAwaitingReply(null);
        playMessageReceive();
      } catch {
        // Offline or stream failure: keep the outbox entry so flush() pushes it
        // on reconnect. Remove the empty assistant placeholder (no reply
        // arrived) and surface the queued message through the banner instead.
        setMessages((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          if (last.role === 'model' && !last.parts) next.pop();
          return next;
        });
        if (!full) setAwaitingReply({ text, clientMessageId: messageId });
      } finally {
        setStreaming(false);
        setLoading(false);
      }
    },
    [client, db, conversationId, entityId]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    void streamTurn(text, { addUser: true });
  }, [input, loading, streamTurn]);

  // Re-run a queued message's turn once the core is reachable again. The user
  // message is already cached/pushed, so this must not add a second copy.
  const retryAwaitingReply = useCallback(() => {
    if (!awaitingReply || loading) return;
    const { text, clientMessageId } = awaitingReply;
    setAwaitingReply(null);
    void streamTurn(text, { clientMessageId, addUser: false });
  }, [awaitingReply, loading, streamTurn]);

  // -----------------------------------------------------------------------
  // Regenerate last assistant response
  // -----------------------------------------------------------------------
  const regenerate = useCallback(async () => {
    if (loading || messages.length < 2) return;

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;

    const lastUserText = messages[lastUserIdx].parts;
    setMessages((m) => {
      const next = [...m];
      if (next[next.length - 1].role === 'model') next.pop();
      return next;
    });
    await streamTurn(lastUserText, { addUser: false });
  }, [loading, messages, streamTurn]);

  // -----------------------------------------------------------------------
  // Reactions (client-side only)
  // -----------------------------------------------------------------------
  const handleReaction = useCallback((messageIndex: number, emoji: string) => {
    setMessages((m) => {
      const next = [...m];
      const msg = { ...next[messageIndex] };
      const reactions = msg.reactions ? [...msg.reactions] : [];
      playReaction();
      const idx = reactions.indexOf(emoji);
      if (idx >= 0) {
        reactions.splice(idx, 1);
      } else {
        reactions.push(emoji);
      }
      msg.reactions = reactions;
      next[messageIndex] = msg;
      return next;
    });
  }, []);

  // -----------------------------------------------------------------------
  // Quick reply handler (fills input only, does NOT auto-send)
  // -----------------------------------------------------------------------
  const handleQuickReply = useCallback((text: string) => {
    setInput(text);
  }, []);

  // -----------------------------------------------------------------------
  // Scroll to message (for search and timeline)
  // -----------------------------------------------------------------------
  const scrollToMessage = useCallback((index: number) => {
    const container = document.querySelector('.overflow-y-auto');
    if (!container) return;
    const messages_divs = container.querySelectorAll('[class*="animate-fade-in"]');
    const target = messages_divs[index];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('ring-2', 'ring-potato-400', 'rounded-xl');
      setTimeout(() => {
        target.classList.remove('ring-2', 'ring-potato-400', 'rounded-xl');
      }, 2000);
    }
  }, []);

  // -----------------------------------------------------------------------
  // Latest assistant text for quick replies
  // -----------------------------------------------------------------------
  const latestAssistantText =
    messages.length > 0 && messages[messages.length - 1].role === 'model'
      ? messages[messages.length - 1].parts
      : '';

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
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
      onReaction={handleReaction}
      onRegenerate={regenerate}
      headerContent={
        <div className="flex items-center justify-end gap-1 px-4 pt-2">
          <ModelPicker />
          <ChatSearch messages={messages} onScrollToMessage={scrollToMessage} />
          <ChatExport messages={messages} entityName={entityName} />
          <SoundToggle />
        </div>
      }
      aboveMessages={
        <MoodTimeline messages={messages} onClickMessage={scrollToMessage} />
      }
      aboveInput={
        <>
          {awaitingReply && (
            <div
              role="status"
              className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg bg-amber-100 dark:bg-amber-900/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
            >
              <span>
                {online
                  ? 'Sent — awaiting reply.'
                  : 'Saved offline — will send when you reconnect.'}
              </span>
              <button
                type="button"
                onClick={retryAwaitingReply}
                disabled={loading}
                className="btn-ghost shrink-0 px-2 py-1 text-xs"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && latestAssistantText ? (
            <QuickReplies
              latestAssistantText={latestAssistantText}
              onSelect={handleQuickReply}
              disabled={loading}
            />
          ) : null}
        </>
      }
    />
  );
}
