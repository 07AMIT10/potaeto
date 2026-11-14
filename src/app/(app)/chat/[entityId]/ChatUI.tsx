'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useCore } from '@/components/providers/CoreProvider';
import { ulid } from '@/lib/core/ulid';
import { ChatBase, type ChatMessage } from '@/components/chat/ChatBase';
import { QuickReplies } from '@/components/QuickReplies';
import { MoodTimeline } from '@/components/MoodTimeline';
import { ChatSearch } from '@/components/ChatSearch';
import { ChatExport } from '@/components/ChatExport';
import { ModelPicker } from '@/components/ModelPicker';
import { ApprovalModal } from '@/components/chat/ApprovalModal';
import { playMessageSend, playMessageReceive, playReaction, isSoundEnabled, setSoundEnabled } from '@/lib/chat/sounds';
import { speechPlayer } from '@/lib/voice/speech';
import { sendNotification } from '@/lib/native/notifications';
import type { AvatarTemplateId } from '@/lib/avatar/template';
import { Potato3DCanvas } from '@/components/avatar/Potato3DCanvas';
import { LiveCaptions } from '@/components/chat/LiveCaptions';
import { VoiceAmbientOrb } from '@/components/chat/VoiceAmbientOrb';
import { useExpression } from '@/lib/expressions/useExpression';
import { useTalkingMouth } from '@/lib/expressions/useTalkingMouth';
import { TaskWorkflowDrawer } from '@/components/tasks/TaskWorkflowDrawer';

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
  const [viewMode, setViewMode] = useState<'voice' | 'classic'>('voice');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isExecutiveDrawerOpen, setIsExecutiveDrawerOpen] = useState(false);

  // A message that is cached/queued but has no assistant answer yet. The
  // banner lets the user retry the turn after reconnecting instead of leaving
  // a silent gap (a full offline agent turn is out of scope for Release 1).
  const [awaitingReply, setAwaitingReply] = useState<{ text: string; clientMessageId: string } | null>(null);
  const [activeApproval, setActiveApproval] = useState<{
    id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    expires_at?: number;
  } | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);

  // Load view mode preference from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('potaeto_chat_view_mode');
      if (saved === 'classic' || saved === 'voice') {
        setViewMode(saved);
      }
    } catch {
      // Fallback
    }
  }, []);

  const handleToggleMode = useCallback((mode: 'voice' | 'classic') => {
    setViewMode(mode);
    try {
      localStorage.setItem('potaeto_chat_view_mode', mode);
    } catch {
      // Fallback
    }
  }, []);

  // Poll speech player speaking state for reactive avatar expressions
  useEffect(() => {
    const interval = setInterval(() => {
      setIsSpeaking(speechPlayer.isSpeaking());
    }, 150);
    return () => clearInterval(interval);
  }, []);

  // Check for any pending unexpired approvals on load or reconnect
  useEffect(() => {
    if (!online || typeof client.getPendingApprovals !== 'function') return;
    let cancelled = false;
    (async () => {
      try {
        const pending = await client.getPendingApprovals();
        if (cancelled) return;
        if (pending && pending.length > 0) {
          const first = pending[0];
          setActiveApproval({
            id: first.id,
            tool_name: first.tool_name,
            arguments: first.arguments,
            expires_at: first.expires_at,
          });
        }
      } catch {
        // Core offline or unauthenticated
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, online]);

  const handleResolveApproval = useCallback(
    async (decision: 'approved' | 'rejected') => {
      if (!activeApproval) return;
      setApprovalLoading(true);
      try {
        await client.resolveApproval(activeApproval.id, decision);
        setActiveApproval(null);
      } finally {
        setApprovalLoading(false);
      }
    },
    [client, activeApproval]
  );

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
          } else if (event.type === 'approval_required' || event.type === 'tool_approval_required') {
            const approvalId = String(event.data.approval_id ?? event.data.id ?? '');
            const toolName = String(event.data.tool_name ?? '');
            const args = (event.data.arguments as Record<string, unknown>) ?? {};
            const expiresAt = typeof event.data.expires_at === 'number' ? event.data.expires_at : undefined;
            setActiveApproval({
              id: approvalId,
              tool_name: toolName,
              arguments: args,
              expires_at: expiresAt,
            });
            void sendNotification({
              title: 'Approval Required',
              body: 'A tool call requires your approval.',
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
        if (full && isSoundEnabled()) {
          void speechPlayer.speak(full);
        }
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
  // Latest assistant text for quick replies and voice hero
  // -----------------------------------------------------------------------
  const latestAssistantText = useMemo(() => {
    if (messages.length === 0) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'model') {
        return messages[i].parts;
      }
    }
    return '';
  }, [messages]);

  // Avatar expressions & talking mouth
  const voiceExpression = useExpression(latestAssistantText, streaming);
  const voiceMouthOpen = useTalkingMouth(streaming, latestChunkLength);

  // Common Header Content with Mode Switch
  const headerContent = (
    <div className="flex items-center justify-between gap-1.5 px-3 sm:px-4 pt-2.5 pb-2 border-b border-[var(--card-border)]/50 min-w-0 bg-[var(--card-bg)]/80 backdrop-blur-sm">
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <Link
          href="/memory"
          className="btn-ghost p-1.5 text-[var(--muted)] hover:text-potato-600 transition-colors shrink-0 text-base"
          title="Memory governance"
          aria-label="Memory governance"
        >
          🧠
        </Link>
        <Link
          href="/hardware"
          className="btn-ghost p-1.5 text-[var(--muted)] hover:text-potato-600 transition-colors shrink-0 text-base"
          title="Hardware & Sensors"
          aria-label="Hardware & Sensors"
        >
          🔌
        </Link>
        <button
          type="button"
          onClick={() => setIsExecutiveDrawerOpen(true)}
          className="btn-ghost p-1.5 text-[var(--muted)] hover:text-potato-600 transition-colors shrink-0 text-base"
          title="Executive Center & Workflows"
          aria-label="Potaeto Executive Center"
          aria-expanded={isExecutiveDrawerOpen}
          aria-controls="potaeto-executive-drawer"
          data-testid="open-executive-drawer-btn"
        >
          ⚡
        </button>
        <ModelPicker />
      </div>

      {/* Mode Switch Toggle */}
      <div className="inline-flex items-center rounded-lg bg-[var(--card-border)]/40 p-0.5 text-xs font-medium shrink-0 mx-1">
        <button
          type="button"
          onClick={() => handleToggleMode('voice')}
          className={`px-2.5 py-1 rounded-md transition-all ${
            viewMode === 'voice'
              ? 'bg-[var(--card-bg)] text-potato-600 dark:text-potato-400 shadow-xs font-semibold'
              : 'text-[var(--muted)] hover:text-[var(--foreground)]'
          }`}
          aria-label="3D Voice Mode"
          title="Switch to Ambient 3D Voice Mode"
        >
          🥔 3D Voice
        </button>
        <button
          type="button"
          onClick={() => handleToggleMode('classic')}
          className={`px-2.5 py-1 rounded-md transition-all ${
            viewMode === 'classic'
              ? 'bg-[var(--card-bg)] text-potato-600 dark:text-potato-400 shadow-xs font-semibold'
              : 'text-[var(--muted)] hover:text-[var(--foreground)]'
          }`}
          aria-label="Classic Chat Mode"
          title="Switch to Classic Chat Bubble Mode"
        >
          💬 Classic
        </button>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <ChatSearch messages={messages} onScrollToMessage={scrollToMessage} />
        <ChatExport messages={messages} entityName={entityName} />
        <SoundToggle />
      </div>
    </div>
  );

  return (
    <>
      {viewMode === 'voice' ? (
        <div className="flex-1 flex flex-col card overflow-hidden min-h-[640px] relative select-none">
          {/* Header */}
          {headerContent}

          {/* Above content (Mood timeline) */}
          <MoodTimeline messages={messages} onClickMessage={scrollToMessage} />

          {/* Voice-First Hero Stage */}
          <div className="flex-1 flex flex-col items-center justify-between p-4 sm:p-6 overflow-y-auto relative">
            {/* Offline Awaiting Reply Banner */}
            {awaitingReply && (
              <div
                role="status"
                className="w-full max-w-xl mx-auto mb-3 flex items-center justify-between gap-3 rounded-lg bg-amber-100 dark:bg-amber-900/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
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

            {/* 3D Potato Hero Avatar */}
            <div className="w-full flex-1 flex flex-col items-center justify-center relative min-h-[300px]">
              <Potato3DCanvas
                expression={voiceExpression.state}
                mouthOpenOverride={voiceMouthOpen}
                isTalking={streaming || isSpeaking}
                height={320}
                className="w-full max-w-md drop-shadow-md"
              />

              {/* Floating Live Captions */}
              <div className="w-full max-w-xl mt-1 mb-2 px-2">
                <LiveCaptions
                  text={latestAssistantText || (streaming ? '...' : '')}
                  isStreaming={streaming}
                  isSpeaking={isSpeaking}
                  onOpenChat={() => handleToggleMode('classic')}
                />
              </div>
            </div>

            {/* Glowing Ambient Microphone Orb */}
            <div className="my-2 flex-shrink-0 flex flex-col items-center justify-center">
              <VoiceAmbientOrb
                onTranscript={(text) => {
                  void streamTurn(text, { addUser: true });
                }}
                disabled={loading}
                isSpeaking={isSpeaking}
              />
            </div>

            {/* Conversation transcript bubbles in voice mode */}
            {messages.length > 0 && (
              <div
                data-testid="voice-messages-log"
                className="w-full max-w-xl flex-1 overflow-y-auto space-y-2.5 my-2 px-2 max-h-48 scrollbar-thin"
              >
                {messages.map((m, idx) => (
                  <div
                    key={idx}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
                  >
                    <div
                      className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                        m.role === 'user'
                          ? 'bg-potato-500 text-white shadow-xs'
                          : 'bg-[var(--card-bg)] border border-[var(--card-border)] text-[var(--foreground)] shadow-xs'
                      }`}
                    >
                      {m.parts}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Quick replies in voice mode */}
            {!loading && latestAssistantText ? (
              <div className="w-full max-w-xl mx-auto mb-2">
                <QuickReplies
                  latestAssistantText={latestAssistantText}
                  onSelect={handleQuickReply}
                  disabled={loading}
                />
              </div>
            ) : null}

            {/* Bottom Keyboard Text Input Bar */}
            <div className="w-full max-w-xl mx-auto pt-1">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
                className="flex items-center gap-2 p-1.5 rounded-full bg-[var(--card-bg)] border border-[var(--card-border)] shadow-xs focus-within:ring-2 focus-within:ring-potato-400/50"
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`Message ${entityName}...`}
                  disabled={loading}
                  className="flex-1 px-4 py-2 bg-transparent text-sm outline-none text-[var(--foreground)] placeholder:text-[var(--muted)]"
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  name="Send"
                  aria-label="Send"
                  className="btn-primary rounded-full px-4 py-2 text-xs font-medium disabled:opacity-40"
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : (
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
          onSpeak={(text) => { void speechPlayer.speak(text); }}
          headerContent={headerContent}
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
      )}

      {activeApproval && (
        <ApprovalModal
          approval={activeApproval}
          loading={approvalLoading}
          onResolve={handleResolveApproval}
        />
      )}

      <TaskWorkflowDrawer
        isOpen={isExecutiveDrawerOpen}
        onClose={() => setIsExecutiveDrawerOpen(false)}
      />
    </>
  );
}
