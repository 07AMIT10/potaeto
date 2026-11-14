import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDb } from '@/lib/core/db';
import { ChatUI } from '../(app)/chat/[entityId]/ChatUI';

let testDb: LocalDb;

vi.mock('@/components/providers/CoreProvider', () => ({
  useCore: () => ({
    client: {
      chatStream: vi.fn(),
      listModels: vi.fn().mockResolvedValue({ models: [], activeModel: null }),
    },
    db: testDb,
    conversationId: 'conv-test-mode',
    syncVersion: 0,
    online: true,
  }),
}));

vi.mock('@/lib/chat/sounds', () => ({
  playMessageSend: vi.fn(),
  playMessageReceive: vi.fn(),
  playReaction: vi.fn(),
  isSoundEnabled: () => false,
  setSoundEnabled: vi.fn(),
}));

describe('ChatUI Mode Toggle (3D Voice vs Classic)', () => {
  beforeEach(async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    localStorage.clear();
    testDb = new LocalDb('test-chat-ui-mode');
    await Promise.all([testDb.messages.clear(), testDb.outbox.clear(), testDb.meta.clear()]);
  });

  afterEach(async () => {
    cleanup();
    if (testDb) {
      await testDb.delete();
    }
  });

  it('renders in Voice Mode by default and allows switching to Classic Mode and back', async () => {
    render(<ChatUI entityId="e_potaeto" entityName="Potaeto" />);

    // In 3D Voice Mode by default
    expect(screen.getByRole('button', { name: /3d voice mode/i })).toHaveClass('font-semibold');

    // Tap to switch to Classic Chat Mode
    fireEvent.click(screen.getByRole('button', { name: /classic chat mode/i }));

    expect(screen.getByRole('button', { name: /classic chat mode/i })).toHaveClass('font-semibold');
    expect(localStorage.getItem('potaeto_chat_view_mode')).toBe('classic');

    // Switch back to 3D Voice Mode
    fireEvent.click(screen.getByRole('button', { name: /3d voice mode/i }));
    expect(screen.getByRole('button', { name: /3d voice mode/i })).toHaveClass('font-semibold');
    expect(localStorage.getItem('potaeto_chat_view_mode')).toBe('voice');
  });
});
