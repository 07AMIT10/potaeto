'use client';

import { useMemo } from 'react';
import type { ChatMessage } from '@/components/chat/ChatBase';
import { resolveExpression } from '@/lib/expressions/useExpression';
import type { ExpressionState } from '@/lib/expressions/types';

// ---------------------------------------------------------------------------
// Mood timeline — a horizontal strip of colored dots showing the
// emotional flow of the conversation.
// ---------------------------------------------------------------------------

interface MoodTimelineProps {
  messages: ChatMessage[];
  onClickMessage?: (index: number) => void;
}

const EXPRESSION_COLORS: Record<ExpressionState, string> = {
  idle: '#9CA3AF',
  happy: '#F59E0B',
  amused: '#FBBF24',
  thoughtful: '#6366F1',
  concerned: '#F97316',
  sad: '#3B82F6',
  excited: '#EF4444',
  confused: '#8B5CF6',
  angry: '#DC2626',
  surprised: '#F472B6',
  shy: '#FDA4AF',
  proud: '#10B981',
  sleepy: '#6B7280',
  loving: '#EC4899',
  mischievous: '#A855F7',
  nervous: '#F59E0B',
};

interface MoodDot {
  messageIndex: number;
  expression: ExpressionState;
  color: string;
  preview: string;
}

export function MoodTimeline({ messages, onClickMessage }: MoodTimelineProps) {
  const dots = useMemo(() => {
    const result: MoodDot[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'model' || !msg.parts) continue;

      const { state } = resolveExpression(msg.parts);
      result.push({
        messageIndex: i,
        expression: state,
        color: EXPRESSION_COLORS[state],
        preview: msg.parts.slice(0, 50) + (msg.parts.length > 50 ? '…' : ''),
      });
    }
    return result;
  }, [messages]);

  if (dots.length < 2) return null;

  return (
    <div className="px-4 py-2 border-b border-[var(--card-border)] overflow-x-auto scrollbar-thin">
      <div className="flex items-center gap-1 min-w-max">
        <span className="text-[9px] text-[var(--muted)] uppercase tracking-wider mr-1 shrink-0">Mood</span>
        {dots.map((dot, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onClickMessage?.(dot.messageIndex)}
            className="group relative flex-shrink-0"
            aria-label={`${dot.expression}: ${dot.preview}`}
          >
            <span
              className="block w-2.5 h-2.5 rounded-full transition-transform hover:scale-150"
              style={{ backgroundColor: dot.color }}
            />
            {/* Tooltip */}
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-[var(--foreground)] text-[var(--background)] text-[9px] rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 max-w-[150px] truncate">
              {dot.expression}: {dot.preview}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
