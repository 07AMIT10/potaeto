import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CoreClient Hardware & Telemetry API', () => {
  it('fetches telemetry data and parses sensor readings correctly', async () => {
    const mockTelemetry = {
      connected: true,
      temperature: 24.2,
      humidity: 52.8,
      pressure: 1013.25,
      light: 350,
      accelerometer: [0.02, -0.01, 9.8],
      ok: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mockTelemetry));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient({ baseUrl: 'http://core' });
    const data = await client.getTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://core/v1/hardware/telemetry');
    expect(init.credentials).toBe('include');

    expect(data).toEqual({
      connected: true,
      temperature: 24.2,
      humidity: 52.8,
      pressure: 1013.25,
      light: 350,
      accelerometer: [0.02, -0.01, 9.8],
      ok: true,
    });
  });

  it('handles disconnected telemetry gracefully with null readings', async () => {
    const mockTelemetry = {
      connected: false,
      temperature: null,
      humidity: null,
      pressure: null,
      light: null,
      accelerometer: null,
      ok: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(mockTelemetry)));

    const client = new CoreClient({ baseUrl: 'http://core' });
    const data = await client.getTelemetry();

    expect(data.connected).toBe(false);
    expect(data.temperature).toBeNull();
    expect(data.humidity).toBeNull();
    expect(data.pressure).toBeNull();
    expect(data.light).toBeNull();
    expect(data.accelerometer).toBeNull();
  });

  it('sends setLedColor POST request with default solid pattern', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient({ baseUrl: 'http://core' });
    const res = await client.setLedColor(0, 255, 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://core/v1/hardware/led');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({
      r: 0,
      g: 255,
      b: 0,
      pattern: 'solid',
    });
    expect(res).toEqual({ ok: true });
  });

  it('sends setLedColor with custom pattern', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoreClient({ baseUrl: 'http://core' });
    const res = await client.setLedColor(255, 128, 0, 'breathe');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://core/v1/hardware/led');
    expect(JSON.parse(init.body as string)).toEqual({
      r: 255,
      g: 128,
      b: 0,
      pattern: 'breathe',
    });
    expect(res).toEqual({ ok: true });
  });

  it('surfaces HTTP errors in getTelemetry and setLedColor as CoreError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'Server error' }, 500)));
    const client = new CoreClient({ baseUrl: 'http://core' });

    await expect(client.getTelemetry()).rejects.toMatchObject({
      name: 'CoreError',
      status: 500,
    });
    await expect(client.setLedColor(255, 0, 0)).rejects.toMatchObject({
      name: 'CoreError',
      status: 500,
    });
  });
});
