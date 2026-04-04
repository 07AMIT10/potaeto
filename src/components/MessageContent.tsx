'use client';

import { parseMessageSpans } from '@/lib/expressions/parser';

interface MessageContentProps {
  text: string;
  isAssistant: boolean;
}

export function MessageContent({ text, isAssistant }: MessageContentProps) {
  if (!isAssistant) {
    return <p className="text-sm whitespace-pre-wrap leading-relaxed">{text || '\u200B'}</p>;
  }

  const spans = parseMessageSpans(text || '');

  if (spans.length === 0) {
    return <p className="text-sm whitespace-pre-wrap leading-relaxed">{'\u200B'}</p>;
  }

  return (
    <p className="text-sm whitespace-pre-wrap leading-relaxed">
      {spans.map((span, i) => {
        if (span.kind === 'action') {
          return (
            <span
              key={i}
              className="italic text-potato-400 dark:text-potato-300 text-[0.8rem] opacity-80"
            >
              *{span.text}*
            </span>
          );
        }
        return <span key={i}>{span.text}</span>;
      })}
    </p>
  );
}
