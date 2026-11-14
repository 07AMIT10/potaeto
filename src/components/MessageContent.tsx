'use client';

import { parseMessageSpans } from '@/lib/expressions/parser';

interface MessageContentProps {
  text: string;
  isAssistant: boolean;
}

// ---------------------------------------------------------------------------
// Lightweight inline markdown renderer
// Regex-based for: **bold**, `code`, ```blocks```, [links](url), [mem_...] citations,
// and list items (- , * , • ). Runs on speech segments only (after *action* parsing).
// ---------------------------------------------------------------------------

interface InlineSegment {
  type: 'text' | 'bold' | 'code' | 'link' | 'citation';
  text: string;
  href?: string;
}

interface BlockSegment {
  type: 'line' | 'list-item' | 'code-block' | 'spacer';
  text?: string;
  language?: string;
  inlines?: InlineSegment[];
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
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

    // Memory citation chip: [mem_01m7b...]
    const memMatch = remaining.match(/^\[(mem_[0-9a-zA-Z]{26})\]/);
    if (memMatch) {
      segments.push({ type: 'citation', text: memMatch[1] });
      remaining = remaining.slice(memMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      segments.push({ type: 'link', text: linkMatch[1], href: linkMatch[2] });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text: consume up to the next special character.
    const nextSpecial = remaining.search(/`[^`]|(?<!\*)\*\*(?!\*)|\[mem_[0-9a-zA-Z]{26}\]|\[.*?\]\(/);
    if (nextSpecial > 0) {
      segments.push({ type: 'text', text: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    } else {
      segments.push({ type: 'text', text: remaining });
      remaining = '';
    }
  }

  return segments;
}

function parseContent(text: string): BlockSegment[] {
  const blocks: BlockSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Code block: ```...```
    const codeBlockMatch = remaining.match(/^```(\w*)\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      blocks.push({
        type: 'code-block',
        text: codeBlockMatch[2],
        language: codeBlockMatch[1] || undefined,
      });
      remaining = remaining.slice(codeBlockMatch[0].length);
      if (remaining.startsWith('\n')) remaining = remaining.slice(1);
      continue;
    }

    const nextCodeBlock = remaining.indexOf('```');
    const textChunk = nextCodeBlock !== -1 ? remaining.slice(0, nextCodeBlock) : remaining;
    remaining = nextCodeBlock !== -1 ? remaining.slice(nextCodeBlock) : '';

    const lines = textChunk.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const listMatch = line.match(/^[-*•]\s+(.+)/);
      if (listMatch) {
        blocks.push({ type: 'list-item', inlines: parseInline(listMatch[1]) });
      } else if (line.trim().length > 0) {
        blocks.push({ type: 'line', inlines: parseInline(line) });
      } else if (i < lines.length - 1) {
        blocks.push({ type: 'spacer' });
      }
    }
  }

  return blocks;
}

function RenderInlines({ inlines }: { inlines: InlineSegment[] }) {
  return (
    <>
      {inlines.map((seg, i) => {
        switch (seg.type) {
          case 'bold':
            return <strong key={i} className="font-semibold text-[var(--foreground)]">{seg.text}</strong>;
          case 'code':
            return (
              <code
                key={i}
                className="text-[0.8rem] bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded-md font-mono"
              >
                {seg.text}
              </code>
            );
          case 'citation':
            return (
              <span
                key={i}
                className="inline-flex items-center text-[0.72rem] font-mono px-1.5 py-0.5 text-potato-600 dark:text-potato-300 bg-potato-500/10 rounded-md border border-potato-500/25 mx-1 select-all"
                title={`Memory Reference: ${seg.text}`}
              >
                {seg.text}
              </span>
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
          default:
            return <span key={i}>{seg.text}</span>;
        }
      })}
    </>
  );
}

function RichText({ text }: { text: string }) {
  const blocks = parseContent(text);

  return (
    <div className="space-y-1">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'code-block':
            return (
              <pre
                key={i}
                className="my-2 p-3 bg-black/5 dark:bg-white/5 rounded-xl text-[0.78rem] font-mono overflow-x-auto leading-relaxed"
              >
                <code>{block.text}</code>
              </pre>
            );
          case 'list-item':
            return (
              <div key={i} className="pl-4 relative before:content-['•'] before:absolute before:left-1 before:text-potato-500 my-0.5">
                {block.inlines && <RenderInlines inlines={block.inlines} />}
              </div>
            );
          case 'spacer':
            return <div key={i} className="h-2" />;
          case 'line':
          default:
            return (
              <div key={i}>
                {block.inlines && <RenderInlines inlines={block.inlines} />}
              </div>
            );
        }
      })}
    </div>
  );
}

export function MessageContent({ text, isAssistant }: MessageContentProps) {
  if (!isAssistant) {
    return <div className="text-sm whitespace-pre-wrap leading-relaxed">{text || '\u200B'}</div>;
  }

  const spans = parseMessageSpans(text || '');

  if (spans.length === 0) {
    return <div className="text-sm whitespace-pre-wrap leading-relaxed">{'\u200B'}</div>;
  }

  return (
    <div className="text-sm whitespace-pre-wrap leading-relaxed space-y-1">
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
    </div>
  );
}
