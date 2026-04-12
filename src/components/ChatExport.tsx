'use client';

import { useCallback } from 'react';
import type { ChatMessage } from '@/components/chat/ChatBase';

// ---------------------------------------------------------------------------
// Chat export — downloads conversation as .md file.
// ---------------------------------------------------------------------------

interface ChatExportProps {
  messages: ChatMessage[];
  entityName: string;
}

function formatConversation(messages: ChatMessage[], entityName: string): string {
  const lines: string[] = [];
  lines.push(`# Conversation with ${entityName}`);
  lines.push(`Exported on ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const speaker = msg.role === 'user' ? '**You**' : `**${entityName}**`;
    const proactiveTag = msg.proactive ? ' _(reached out)_' : '';
    lines.push(`${speaker}${proactiveTag}:`);
    lines.push(msg.parts);
    lines.push('');
  }

  return lines.join('\n');
}

export function ChatExport({ messages, entityName }: ChatExportProps) {
  const handleExport = useCallback(() => {
    if (messages.length === 0) return;

    const content = formatConversation(messages, entityName);
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-${entityName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [messages, entityName]);

  if (messages.length === 0) return null;

  return (
    <button
      type="button"
      onClick={handleExport}
      className="btn-ghost p-2 text-[var(--muted)]"
      aria-label="Export conversation"
      title="Export conversation"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
    </button>
  );
}
