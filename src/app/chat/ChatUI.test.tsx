import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDb } from '@/lib/core/db';
import { ChatUI } from '../(app)/chat/[entityId]/ChatUI';

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [], activeModel: null }),
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

let testDb: LocalDb;

vi.mock('@/components/providers/CoreProvider', () => ({
  useCore: () => ({
    client: {
      chatStream: mocks.chatStream,
      listModels: mocks.listModels,
    },
    db: testDb,
    conversationId: 'conv-test-1',
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

vi.mock('@/lib/native/notifications', () => ({
  sendNotification: mocks.sendNotification,
}));

beforeEach(async () => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.chatStream.mockReset();
  mocks.listModels.mockResolvedValue({ models: [], activeModel: null });

  testDb = new LocalDb('test-chat-ui');
  await Promise.all([testDb.messages.clear(), testDb.outbox.clear(), testDb.meta.clear()]);
});

afterEach(async () => {
  cleanup();
  if (testDb) {
    await testDb.delete();
  }
});

describe('ChatUI offline retry deduplication', () => {
  it('preserves clientMessageId on retry and avoids duplicate messages', async () => {
    // 1. First attempt: streaming fails due to offline/network failure
    mocks.chatStream.mockImplementationOnce(async function* () {
      throw new Error('Network error (offline)');
    });

    render(<ChatUI entityId="e_potaeto" entityName="Potaeto" />);

    // Wait for initial load to settle
    const input = await screen.findByPlaceholderText(/message potaeto/i);
    fireEvent.change(input, { target: { value: 'Test retry dedup message' } });

    const sendButton = screen.getByRole('button', { name: /^send$/i });
    fireEvent.click(sendButton);

    // Initial stream call fails
    await waitFor(() => expect(mocks.chatStream).toHaveBeenCalledTimes(1));
    const firstCallArgs = mocks.chatStream.mock.calls[0][0];
    expect(firstCallArgs.message).toBe('Test retry dedup message');
    const originalMessageId = firstCallArgs.clientMessageId;
    expect(originalMessageId).toBeTruthy();

    // Awaiting reply banner is shown with retry button
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/awaiting reply/i);

    // Verify exactly 1 user message in the UI and in IndexedDB outbox
    expect(screen.getAllByText('Test retry dedup message')).toHaveLength(1);
    expect(await testDb.outbox.count()).toBe(1);
    const outboxEntry = await testDb.outbox.toCollection().first();
    expect(outboxEntry?.idempotencyKey).toBe(originalMessageId);

    // 2. Prepare mock for successful retry
    mocks.chatStream.mockImplementationOnce(async function* () {
      yield { type: 'token', data: { text: 'Assistant reply succeeded' } };
      yield { type: 'done', data: { message_id: 'asst-1' } };
    });

    const retryButton = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retryButton);

    // 3. Verify second stream call reused the EXACT same clientMessageId
    await waitFor(() => expect(mocks.chatStream).toHaveBeenCalledTimes(2));
    const secondCallArgs = mocks.chatStream.mock.calls[1][0];
    expect(secondCallArgs.message).toBe('Test retry dedup message');
    expect(secondCallArgs.clientMessageId).toBe(originalMessageId);

    // 4. Verify reply arrives, banner is dismissed, no duplicate user message
    await waitFor(() => {
      expect(screen.getByText('Assistant reply succeeded')).toBeInTheDocument();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByText('Test retry dedup message')).toHaveLength(1);

    // Outbox was cleared because the turn streamed successfully
    expect(await testDb.outbox.count()).toBe(0);
  });

  it('triggers sendNotification when an approval_required event is received', async () => {
    mocks.chatStream.mockImplementationOnce(async function* () {
      yield {
        type: 'approval_required',
        data: {
          approval_id: 'appr-123',
          tool_name: 'arduino_flash',
          arguments: { port: '/dev/ttyUSB0' },
        },
      };
      yield { type: 'token', data: { text: 'Waiting for approval' } };
      yield { type: 'done', data: { message_id: 'asst-2' } };
    });

    render(<ChatUI entityId="e_potaeto" entityName="Potaeto" />);

    const input = await screen.findByPlaceholderText(/message potaeto/i);
    fireEvent.change(input, { target: { value: 'Run tool requiring approval' } });

    const sendButton = screen.getByRole('button', { name: /^send$/i });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(mocks.sendNotification).toHaveBeenCalledWith({
        title: 'Approval Required',
        body: 'A tool call requires your approval.',
      });
    });
  });
});
