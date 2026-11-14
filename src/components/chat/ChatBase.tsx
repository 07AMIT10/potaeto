'use client';

import { useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { AvatarFace } from '@/components/AvatarFace';
import { MessageContent } from '@/components/MessageContent';
import { useExpression } from '@/lib/expressions/useExpression';
import { useTalkingMouth } from '@/lib/expressions/useTalkingMouth';
import { useGaze } from '@/lib/expressions/useGaze';
import type { AvatarTemplateId } from '@/lib/avatar/template';
import type { ExpressionState } from '@/lib/expressions/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'model';
  parts: string;
  proactive?: boolean;
  /** Client-side emoji reactions (not persisted to DB). */
  reactions?: string[];
}

export interface ChatBaseProps {
  messages: ChatMessage[];
  entityName: string;
  avatarTemplate?: AvatarTemplateId;
  loading: boolean;
  streaming: boolean;
  initialLoading: boolean;
  /** Latest chunk length for talking mouth animation. */
  latestChunkLength: number;
  /** Input value (controlled). */
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  /** Disables input (e.g. trial exhausted). */
  inputDisabled?: boolean;
  /** Custom placeholder text. */
  inputPlaceholder?: string;
  /** Content rendered above the input (e.g. quick replies, trial message). */
  aboveInput?: ReactNode;
  /** Content rendered below the chat card (e.g. CTAs). */
  belowChat?: ReactNode;
  /** Content rendered in the header area. */
  headerContent?: ReactNode;
  /** Mood timeline or similar above messages. */
  aboveMessages?: ReactNode;
  /** Called when user reacts to a message. */
  onReaction?: (messageIndex: number, emoji: string) => void;
  /** Show regenerate button on last assistant message. */
  onRegenerate?: () => void;
  /** Min height for the chat container. */
  minHeight?: string;
  /** Max height for the chat container. */
  maxHeight?: string;
  /** Size of avatar face. */
  avatarSize?: number;
}

// ---------------------------------------------------------------------------
// Reaction emoji presets
// ---------------------------------------------------------------------------

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🥰'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatBase({
  messages,
  entityName,
  avatarTemplate = 'potato',
  loading,
  streaming,
  initialLoading,
  latestChunkLength,
  input,
  onInputChange,
  onSend,
  inputDisabled = false,
  inputPlaceholder,
  aboveInput,
  belowChat,
  headerContent,
  aboveMessages,
  onReaction,
  onRegenerate,
  minHeight,
  maxHeight,
  avatarSize = 32,
}: ChatBaseProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const [hoveredMessage, setHoveredMessage] = useState<number | null>(null);

  // -----------------------------------------------------------------------
  // Expression system
  // -----------------------------------------------------------------------
  const latestAssistantText =
    messages.length > 0 && messages[messages.length - 1].role === 'model'
      ? messages[messages.length - 1].parts
      : '';
  const expression = useExpression(latestAssistantText, streaming);

  // Talking mouth animation.
  const mouthOpen = useTalkingMouth(streaming, latestChunkLength);

  // Gaze tracking.
  const { gazeX, gazeY } = useGaze(avatarRef);

  // -----------------------------------------------------------------------
  // Auto-scroll
  // -----------------------------------------------------------------------
  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  // Focus input after loading completes.
  useEffect(() => {
    if (!loading && !initialLoading) {
      inputRef.current?.focus();
    }
  }, [loading, initialLoading]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  const containerStyle: React.CSSProperties = {};
  if (minHeight) containerStyle.minHeight = minHeight;
  if (maxHeight) containerStyle.maxHeight = maxHeight;

  return (
    <>
      <div
        className="flex-1 flex flex-col card overflow-hidden"
        style={containerStyle}
      >
        {/* Header */}
        {headerContent}

        {/* Mood timeline / above-messages slot */}
        {aboveMessages}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 scrollbar-thin">
          {/* Initial loading */}
          {initialLoading && (
            <div className="flex justify-center py-8">
              <div className="flex gap-1.5">
                <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                <span className="typing-dot" style={{ animationDelay: '150ms' }} />
                <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          {/* Empty state */}
          {!initialLoading && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div ref={avatarRef}>
                <AvatarFace
                  template={avatarTemplate}
                  expression="idle"
                  size={56}
                  className="mb-4 animate-potato-appear"
                />
              </div>
              <p className="text-sm text-[var(--muted)] max-w-xs">
                Start a conversation with {entityName}. They&apos;ll stay in character.
              </p>
            </div>
          )}

          {/* Message list */}
          {messages.map((msg, i) => {
            const isLastAssistant = msg.role === 'model' && i === messages.length - 1;
            const isAssistant = msg.role === 'model';
            const isHovered = hoveredMessage === i;

            return (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in group relative`}
                onMouseEnter={() => setHoveredMessage(i)}
                onMouseLeave={() => setHoveredMessage(null)}
              >
                {/* Avatar */}
                {isAssistant && (
                  <div className="flex-shrink-0 mr-2 self-end mb-1" ref={isLastAssistant ? avatarRef : undefined}>
                    {isLastAssistant ? (
                      <AvatarFace
                        template={avatarTemplate}
                        expression={expression.state}
                        intensity={expression.intensity}
                        size={avatarSize}
                        mouthOpenOverride={mouthOpen}
                        gazeX={gazeX}
                        gazeY={gazeY}
                      />
                    ) : (
                      <AvatarFace template={avatarTemplate} expression="idle" size={avatarSize} className="opacity-50" />
                    )}
                  </div>
                )}

                {/* Bubble */}
                <div className="relative max-w-[86%] sm:max-w-[72%]">
                  {/* Proactive label */}
                  {msg.proactive && isAssistant && (
                    <span className="inline-block text-[10px] font-medium text-potato-500 mb-1 uppercase tracking-wide">
                      {entityName} reached out
                    </span>
                  )}

                  <div className={`${
                    msg.role === 'user'
                      ? 'rounded-2xl rounded-br-md bg-potato-500 text-white px-4 py-2.5'
                      : 'rounded-2xl rounded-bl-md bg-[var(--card)] border border-[var(--card-border)] px-4 py-2.5'
                  }`}>
                    <MessageContent text={msg.parts} isAssistant={isAssistant} />
                  </div>

                  {/* Reactions display */}
                  {msg.reactions && msg.reactions.length > 0 && (
                    <div className="flex gap-0.5 mt-1">
                      {msg.reactions.map((emoji, ri) => (
                        <span
                          key={ri}
                          className="inline-flex items-center justify-center w-6 h-6 text-xs rounded-full bg-[var(--card)] border border-[var(--card-border)] shadow-sm animate-fade-in"
                        >
                          {emoji}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Reaction picker (on hover) */}
                  {isHovered && onReaction && (
                    <div className={`absolute ${msg.role === 'user' ? 'right-0' : 'left-10'} -bottom-7 z-10 flex gap-0.5 bg-[var(--card)] border border-[var(--card-border)] rounded-full px-1.5 py-0.5 shadow-lg animate-fade-in`}>
                      {REACTION_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="w-6 h-6 text-xs rounded-full hover:bg-potato-100 dark:hover:bg-potato-900/30 transition-colors flex items-center justify-center"
                          onClick={(e) => {
                            e.stopPropagation();
                            onReaction(i, emoji);
                          }}
                          aria-label={`React with ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Regenerate button */}
                  {isLastAssistant && !loading && onRegenerate && (
                    <button
                      type="button"
                      onClick={onRegenerate}
                      className="absolute -bottom-6 left-10 text-[10px] text-[var(--muted)] hover:text-potato-600 dark:hover:text-potato-400 flex items-center gap-1 transition-colors opacity-0 group-hover:opacity-100"
                      aria-label="Regenerate response"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Regenerate
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Streaming cursor */}
          {loading && streaming && messages[messages.length - 1]?.role === 'model' && messages[messages.length - 1].parts && (
            <div className="flex justify-start pl-10">
              <span className="inline-block w-1.5 h-4 bg-potato-400 rounded-full animate-pulse" />
            </div>
          )}

          {/* Typing indicator (pre-stream) */}
          {loading && !streaming && (
            <div className="flex justify-start animate-fade-in">
              <div className="flex-shrink-0 mr-2 self-end mb-1">
                <AvatarFace template={avatarTemplate} expression="idle" size={avatarSize} className="opacity-70" />
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

        {/* Input area */}
        <form
          className="p-3 sm:p-4 border-t border-[var(--card-border)] flex flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); onSend(); }}
        >
          {aboveInput}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={inputPlaceholder ?? `Message ${entityName}...`}
              disabled={loading || inputDisabled}
              className="input-field flex-1"
            />
            <button
              type="submit"
              disabled={loading || inputDisabled || !input.trim()}
              className="btn-primary px-4"
              aria-label="Send"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
              </svg>
            </button>
          </div>
        </form>
      </div>

      {/* Below chat slot (e.g. CTAs) */}
      {belowChat}
    </>
  );
}
