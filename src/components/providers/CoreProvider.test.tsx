import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDb } from '@/lib/core/db';
import { CoreProvider, coreBaseUrl, useCore } from './CoreProvider';

// The provider constructs its own CoreClient; stub the HTTP client so boot can
// succeed (online) or fail (offline) without touching the network.
const mocks = vi.hoisted(() => ({
  getPrimaryAgent: vi.fn(),
  getConversation: vi.fn(),
  push: vi.fn(),
  sync: vi.fn(),
  clientOptions: [] as Array<{ baseUrl: string }>,
}));

vi.mock('@/lib/core/client', () => ({
  CoreError: class CoreError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = 'CoreError';
    }
  },
  CoreClient: class {
    constructor(options: { baseUrl: string }) {
      mocks.clientOptions.push(options);
    }

    getPrimaryAgent = mocks.getPrimaryAgent;
    getConversation = mocks.getConversation;
    push = mocks.push;
    sync = mocks.sync;
  },
}));

const AGENT = { id: 'e_potaeto', name: 'Potaeto', slug: 'potaeto', avatar: null };

function Probe() {
  const { agent, conversationId, booted } = useCore();
  return (
    <div>
      <span data-testid="booted">{booted ? 'yes' : 'no'}</span>
      <span data-testid="agent">{agent?.id ?? 'none'}</span>
      <span data-testid="conversation">{conversationId ?? 'none'}</span>
    </div>
  );
}

beforeEach(async () => {
  mocks.getPrimaryAgent.mockReset();
  mocks.getConversation.mockReset();
  mocks.push.mockReset();
  mocks.sync.mockReset();
  mocks.clientOptions.length = 0;

  const db = new LocalDb('potaeto');
  await Promise.all([db.meta.clear(), db.messages.clear(), db.outbox.clear()]);
  db.close();
});

afterEach(() => {
  cleanup();
});

describe('CoreProvider', () => {
  it('defaults to a relative core URL for same-origin production builds', async () => {
    // An unset/empty NEXT_PUBLIC_CORE_URL must produce relative `/v1/*`
    // requests; a baked-in `http://localhost:8000` breaks the remote PWA.
    expect(coreBaseUrl(undefined)).toBe('');
    expect(coreBaseUrl('')).toBe('');
    expect(coreBaseUrl('http://localhost:8000')).toBe('http://localhost:8000');

    mocks.getPrimaryAgent.mockRejectedValue(new TypeError('Failed to fetch'));
    mocks.getConversation.mockRejectedValue(new TypeError('Failed to fetch'));

    render(
      <CoreProvider>
        <Probe />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('booted')).toHaveTextContent('yes'));
    expect(mocks.clientOptions[0]).toEqual({ baseUrl: coreBaseUrl() });
  });

  it('persists the agent and conversation after a successful boot', async () => {
    mocks.getPrimaryAgent.mockResolvedValue(AGENT);
    mocks.getConversation.mockResolvedValue({ id: 'c1', entityId: 'e_potaeto' });
    mocks.push.mockResolvedValue([]);
    mocks.sync.mockResolvedValue({ changes: [], nextSeq: 0, hasMore: false });

    render(
      <CoreProvider>
        <Probe />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('booted')).toHaveTextContent('yes'));
    expect(screen.getByTestId('conversation')).toHaveTextContent('c1');

    const cached = new LocalDb('potaeto');
    await expect(cached.getAgent()).resolves.toEqual(AGENT);
    await expect(cached.getConversationId()).resolves.toBe('c1');
    cached.close();
  });

  it('hydrates the cached agent and conversation when boot fails offline', async () => {
    const seed = new LocalDb('potaeto');
    await seed.saveAgent(AGENT);
    await seed.saveConversationId('c_cached');
    await seed.messages.put({
      id: 'm1',
      conversationId: 'c_cached',
      role: 'user',
      content: 'cached turn',
      createdAt: '2026-01-01T00:00:00Z',
    });
    seed.close();

    mocks.getPrimaryAgent.mockRejectedValue(new TypeError('Failed to fetch'));
    mocks.getConversation.mockRejectedValue(new TypeError('Failed to fetch'));

    render(
      <CoreProvider>
        <Probe />
      </CoreProvider>,
    );

    // Offline: boot fails, but the cached agent/conversation still render so
    // the chat history (and the outbox for queued sends) stays usable.
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('e_potaeto'));
    expect(screen.getByTestId('conversation')).toHaveTextContent('c_cached');
    expect(screen.getByTestId('booted')).toHaveTextContent('yes');

    const cached = new LocalDb('potaeto');
    await expect(cached.messages.get('m1')).resolves.toMatchObject({
      conversationId: 'c_cached',
      content: 'cached turn',
    });
    cached.close();
  });

  it('does not resurrect a stale cache when the device is unpaired', async () => {
    const seed = new LocalDb('potaeto');
    await seed.saveAgent(AGENT);
    await seed.saveConversationId('c_cached');
    seed.close();

    const { CoreError } = await import('@/lib/core/client');
    mocks.getPrimaryAgent.mockRejectedValue(new CoreError('unauthorized', 401));
    mocks.getConversation.mockRejectedValue(new CoreError('unauthorized', 401));

    render(
      <CoreProvider>
        <Probe />
      </CoreProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('booted')).toHaveTextContent('yes'));
    expect(screen.getByTestId('agent')).toHaveTextContent('none');
    expect(screen.getByTestId('conversation')).toHaveTextContent('none');
  });
});
