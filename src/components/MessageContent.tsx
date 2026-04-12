'use client';

import { parseMessageSpans } from '@/lib/expressions/parser';

interface MessageContentProps {
  text: string;
  isAssistant: boolean;
}

// ---------------------------------------------------------------------------
// Lightweight inline markdown renderer
// No heavy dependencies — regex-based for: **bold**, `code`, ```blocks```,
// [links](url), - lists. Runs on speech segments only (after *action* parsing).
// ---------------------------------------------------------------------------

interface MarkdownSegment {
  type: 'text' | 'bold' | 'code' | 'code-block' | 'link' | 'list-item';
  text: string;
  href?: string;
  language?: string;
}

function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Code block: ```...```
    const codeBlockMatch = remaining.match(/^```(\w*)\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      segments.push({
        type: 'code-block',
        text: codeBlockMatch[2],
        language: codeBlockMatch[1] || undefined,
      });
      remaining = remaining.slice(codeBlockMatch[0].length);
      continue;
    }

    // Inline code: `...`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      segments.push({ type: 'code', text: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold: **...**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      segments.push({ type: 'bold', text: boldMatch[1] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      segments.push({ type: 'link', text: linkMatch[1], href: linkMatch[2] });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // List item: starts with "- " at beginning of line
    const listMatch = remaining.match(/^(?:^|\n)- (.+)/);
    if (listMatch && (segments.length === 0 || remaining.startsWith('\n- ') || remaining.startsWith('- '))) {
      const offset = remaining.startsWith('\n') ? 1 : 0;
      segments.push({ type: 'list-item', text: listMatch[1] });
      remaining = remaining.slice(listMatch[0].length + offset - (offset ? 1 : 0));
      // Consume newline prefix.
      if (remaining.startsWith('\n- ') || remaining.startsWith('- ')) {
        // Keep going, next iteration will catch it.
      }
      continue;
    }

    // Plain text: consume up to the next special character.
    const nextSpecial = remaining.search(/```|`[^`]|(?<!\*)\*\*(?!\*)|\[.*?\]\(|\n- /);
    if (nextSpecial > 0) {
      segments.push({ type: 'text', text: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    } else {
      // No more markdown — consume rest.
      segments.push({ type: 'text', text: remaining });
      remaining = '';
    }
  }

  return segments;
}

function RichText({ text }: { text: string }) {
  const segments = parseMarkdown(text);

  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'bold':
            return <strong key={i} className="font-semibold">{seg.text}</strong>;
          case 'code':
            return (
              <code
                key={i}
                className="text-[0.8rem] bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded-md font-mono"
              >
                {seg.text}
              </code>
            );
          case 'code-block':
            return (
              <pre
                key={i}
                className="my-2 p-3 bg-black/5 dark:bg-white/5 rounded-xl text-[0.78rem] font-mono overflow-x-auto leading-relaxed"
              >
                <code>{seg.text}</code>
              </pre>
            );
          case 'link':
            return (
              <a
                key={i}
                href={seg.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-potato-600 dark:text-potato-400 underline underline-offset-2 hover:text-potato-700 dark:hover:text-potato-300 transition-colors"
              >
                {seg.text}
              </a>
            );
          case 'list-item':
            return (
              <span key={i} className="block pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-[var(--muted)]">
                {seg.text}
              </span>
            );
          default:
            return <span key={i}>{seg.text}</span>;
        }
      })}
    </>
  );
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
        // Speech segments get markdown rendering.
        return <RichText key={i} text={span.text} />;
      })}
    </p>
  );
}
