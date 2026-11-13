import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));

import PairPage from './page';

function fillForm(code = 'a'.repeat(32), deviceName = 'phone') {
  fireEvent.change(screen.getByLabelText('Pairing code'), {
    target: { value: code },
  });
  fireEvent.change(screen.getByLabelText('Device name'), {
    target: { value: deviceName },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Pair device' }));
}

beforeEach(() => {
  mocks.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PairPage', () => {
  it('posts the code and device name with credentials, then opens chat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    render(<PairPage />);
    fillForm('code-123', 'my phone');

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/chat'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/v1/auth/pair');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(init.body)).toEqual({
      code: 'code-123',
      device_name: 'my phone',
    });
  });

  it('shows a clear error for an invalid or expired code and stays put', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );

    render(<PairPage />);
    fillForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid or has expired/i);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('renders the Storage & Sync card and persistence status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    render(<PairPage />);
    expect(screen.getByRole('heading', { name: /Storage & Sync/i })).toBeInTheDocument();
    expect(await screen.findByTestId('persistence-badge')).toBeInTheDocument();
  });
});
