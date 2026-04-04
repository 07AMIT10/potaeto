import type { MessageSpan } from './types';

const ACTION_REGEX = /\*([^*]{1,120})\*/g;

export function parseMessageSpans(text: string): MessageSpan[] {
  const spans: MessageSpan[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  ACTION_REGEX.lastIndex = 0;
  while ((match = ACTION_REGEX.exec(text)) !== null) {
    const fullMatch = match[0];
    const innerText = match[1];
    const matchStart = match.index;

    if (matchStart > lastIndex) {
      spans.push({
        kind: 'speech',
        text: text.slice(lastIndex, matchStart),
        startIndex: lastIndex,
        endIndex: matchStart,
      });
    }

    spans.push({
      kind: 'action',
      text: innerText,
      startIndex: matchStart,
      endIndex: matchStart + fullMatch.length,
    });

    lastIndex = matchStart + fullMatch.length;
  }

  if (lastIndex < text.length) {
    spans.push({
      kind: 'speech',
      text: text.slice(lastIndex),
      startIndex: lastIndex,
      endIndex: text.length,
    });
  }

  return spans;
}

export function extractActionTexts(text: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = /\*([^*]{1,120})\*/g;
  while ((match = re.exec(text)) !== null) {
    results.push(match[1]);
  }
  return results;
}
