import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './client';

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CoreClient', () => {
  it('parses SSE frames into AgentEvents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse('event: token\ndata: {"text":"hi"}\n\nevent: done\ndata: {"message_id":"m1"}\n\n')
      )
    );
    const client = new CoreClient({ baseUrl: 'http://core' });
    const events = [];
    for await (const event of client.chatStream({
      conversationId: 'c1',
      message: 'hello',
      clientMessageId: 'ulid1',
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'token', data: { text: 'hi' } },
      { type: 'done', data: { message_id: 'm1' } },
    ]);
  });

  it('treats an empty base URL as same-origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'e_potaeto' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient({ baseUrl: '' });
    await client.getPrimaryAgent();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/v1/agent');
  });

  it('posts the chat stream with credentials and a snake_case body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('event: done\ndata: {}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient({ baseUrl: 'http://core/' });
    for await (const _event of client.chatStream({
      conversationId: 'c1',
      message: 'hello',
      clientMessageId: 'ulid1',
    })) {
      // drain
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://core/v1/chat/stream');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({
      conversation_id: 'c1',
      message: 'hello',
      client_message_id: 'ulid1',
    });
  });

  it('maps the sync wire shape to camelCase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          changes: [
            {
              seq: 3,
              entity_type: 'message',
              entity_id: 'm1',
              operation: 'insert',
              payload: { content: 'hi' },
              server_created_at: '2026-01-01T00:00:00Z',
            },
          ],
          next_seq: 3,
          has_more: false,
        })
      )
    );
    const client = new CoreClient({ baseUrl: 'http://core' });
    const res = await client.sync(0);
    expect(res).toEqual({
      changes: [
        {
          seq: 3,
          entityType: 'message',
          entityId: 'm1',
          operation: 'insert',
          payload: { content: 'hi' },
          serverCreatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      nextSeq: 3,
      hasMore: false,
    });
  });

  it('maps push operations and results across the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ idempotency_key: 'k1', status: 'applied', rev: 1, seq: 7, error: null }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient({ baseUrl: 'http://core' });
    const results = await client.push([
      { idempotencyKey: 'k1', entityType: 'message', entityId: 'm1', baseRev: 0, payload: { content: 'hi' } },
    ]);
    expect(results).toEqual([{ idempotencyKey: 'k1', status: 'applied', rev: 1, seq: 7, error: null }]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      operations: [
        {
          idempotency_key: 'k1',
          entity_type: 'message',
          entity_id: 'm1',
          base_rev: 0,
          payload: { content: 'hi' },
        },
      ],
    });
  });

  it('surfaces non-2xx responses as a typed error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    const client = new CoreClient({ baseUrl: 'http://core' });
    await expect(client.getPrimaryAgent()).rejects.toMatchObject({ status: 401 });
  });
});
