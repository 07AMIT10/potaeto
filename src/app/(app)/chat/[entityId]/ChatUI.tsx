'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuthMode } from '@/lib/auth/useAuthMode';
import { loadGuestChat, saveGuestChat, type GuestChatMessage } from '@/lib/guestStorage';
import { ChatBase, type ChatMessage } from '@/components/chat/ChatBase';
import { QuickReplies } from '@/components/QuickReplies';
import { MoodTimeline } from '@/components/MoodTimeline';
import { ChatSearch } from '@/components/ChatSearch';
import { ChatExport } from '@/components/ChatExport';
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [latestChunkLength, setLatestChunkLength] = useState(0);

  const auth = useAuthMode();

  // -----------------------------------------------------------------------
  // Load history
  // -----------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (auth.mode === 'guest') {
          const loadedGuest: GuestChatMessage[] = loadGuestChat(entityId);
          if (cancelled) return;
          const mapped: ChatMessage[] = loadedGuest.map((m) => ({
            role: m.role,
            parts: m.parts,
          }));
          setMessages(mapped);
        } else {
          const res = await fetch(`/api/conversations/${entityId}/messages`);
          const data = await res.json();
          if (!res.ok || cancelled) return;
          const loaded: ChatMessage[] = (data.messages ?? []).map(
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
      }
    })();
    return () => { cancelled = true; };
  }, [auth.mode, entityId]);

  // -----------------------------------------------------------------------
  // Send message (streaming)
  // -----------------------------------------------------------------------
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: ChatMessage = { role: 'user', parts: text };
    setMessages((m) => [...m, userMsg]);
    playMessageSend();
    setLoading(true);
    setStreaming(false);
    setLatestChunkLength(0);

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
        playMessageReceive();
        setLoading(false);
        const finalMessages: ChatMessage[] = [];
        setMessages((m) => {
          finalMessages.push(...m);
          return m;
        });
        const toStore: GuestChatMessage[] = finalMessages.map((m) => ({
          role: m.role,
          parts: m.parts,
        }));
        saveGuestChat(entityId, toStore);
        return;
      }

      // Authenticated user.
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
      playMessageReceive();

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
  }, [input, loading, messages, auth.mode, entityId, entityName]);

  // -----------------------------------------------------------------------
  // Regenerate last assistant response
  // -----------------------------------------------------------------------
  const regenerate = useCallback(async () => {
    if (loading || messages.length < 2) return;

    // Find the last user message to re-send.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;

    const lastUserText = messages[lastUserIdx].parts;

    // Remove the last assistant message.
    setMessages((m) => {
      const next = [...m];
      if (next[next.length - 1].role === 'model') {
        next.pop();
      }
      return next;
    });

    // Re-send via the same flow.
    setInput(lastUserText);
    // We'll trigger send on next tick after input updates.
    setTimeout(() => {
      setInput('');
      // Manually trigger send logic with the user text.
      const doRegenerate = async () => {
        setLoading(true);
        setStreaming(false);
        setLatestChunkLength(0);

        try {
          const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entityId, message: lastUserText }),
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
      };
      doRegenerate();
    }, 0);
  }, [loading, messages, entityId]);

  // -----------------------------------------------------------------------
  // Reactions (client-side only)
  // -----------------------------------------------------------------------
  const handleReaction = useCallback((messageIndex: number, emoji: string) => {
    setMessages((m) => {
      const next = [...m];
      const msg = { ...next[messageIndex] };
      const reactions = msg.reactions ? [...msg.reactions] : [];
      playReaction();
      // Toggle: if already reacted with this emoji, remove it.
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
  // Scroll to message (for search and timeline).
  // -----------------------------------------------------------------------
  const scrollToMessage = useCallback((index: number) => {
    // ChatBase renders message list — we scroll to the container's child.
    const container = document.querySelector('.overflow-y-auto');
    if (!container) return;
    const messages_divs = container.querySelectorAll('[class*="animate-fade-in"]');
    const target = messages_divs[index];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight.
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
      onRegenerate={auth.mode !== 'guest' ? regenerate : undefined}
      headerContent={
        <div className="flex items-center justify-end gap-1 px-4 pt-2">
          <ChatSearch messages={messages} onScrollToMessage={scrollToMessage} />
          <ChatExport messages={messages} entityName={entityName} />
          <SoundToggle />
        </div>
      }
      aboveMessages={
        <MoodTimeline messages={messages} onClickMessage={scrollToMessage} />
      }
      aboveInput={
        !loading && latestAssistantText ? (
          <QuickReplies
            latestAssistantText={latestAssistantText}
            onSelect={handleQuickReply}
            disabled={loading}
          />
        ) : undefined
      }
    />
  );
}
