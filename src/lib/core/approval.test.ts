import { describe, it, expect, vi, afterEach } from 'vitest';
import { CoreClient } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CoreClient approval API', () => {
  it('sends approval resolution POST request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'appr_1', status: 'approved' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient('http://localhost:8010');
    const res = await client.resolveApproval('appr_1', 'approved');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8010/v1/approvals/appr_1/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' }),
      })
    );
    expect(res.status).toBe('approved');
  });

  it('sends approval rejection POST request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'appr_2', status: 'rejected' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient({ baseUrl: 'http://localhost:8010' });
    const res = await client.resolveApproval('appr_2', 'rejected');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8010/v1/approvals/appr_2/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'rejected' }),
      })
    );
    expect(res.status).toBe('rejected');
  });

  it('throws an error if resolveApproval fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient('http://localhost:8010');
    await expect(client.resolveApproval('appr_missing', 'approved')).rejects.toThrow(
      'Failed to resolve approval: Not Found'
    );
  });

  it('fetches pending approvals via GET request', async () => {
    const mockApprovals = [
      {
        id: 'appr_1',
        action_hash: 'hash1',
        tool_name: 'run_command',
        arguments: { command: 'ls -la' },
        status: 'pending',
        expires_at: 1700000000,
        created_at: 1699999000,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockApprovals,
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient('http://localhost:8010');
    const res = await client.getPendingApprovals();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8010/v1/approvals/pending',
      expect.objectContaining({
        credentials: 'include',
      })
    );
    expect(res).toEqual(mockApprovals);
  });

  it('throws an error if getPendingApprovals fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient('http://localhost:8010');
    await expect(client.getPendingApprovals()).rejects.toThrow(
      'Failed to fetch approvals: Internal Server Error'
    );
  });
});
