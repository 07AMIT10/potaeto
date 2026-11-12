import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArduinoPanel } from './ArduinoPanel';
import { ColorPicker } from './ColorPicker';
import type { TelemetryData } from '@/lib/core/types';

const mockTelemetryConnected: TelemetryData = {
  connected: true,
  temperature: 24.5,
  humidity: 50.2,
  pressure: 1013.25,
  light: 320,
  accelerometer: [0.05, -0.02, 9.81],
  ok: true,
};

const mockTelemetryDisconnected: TelemetryData = {
  connected: false,
  temperature: null,
  humidity: null,
  pressure: null,
  light: null,
  accelerometer: null,
  ok: true,
};

const mocks = vi.hoisted(() => ({
  getTelemetry: vi.fn(),
  setLedColor: vi.fn(),
}));

vi.mock('@/components/providers/CoreProvider', () => ({
  useCore: () => ({
    client: {
      getTelemetry: mocks.getTelemetry,
      setLedColor: mocks.setLedColor,
    },
    online: true,
  }),
  coreBaseUrl: () => '',
}));

beforeEach(() => {
  mocks.getTelemetry.mockReset();
  mocks.setLedColor.mockReset();

  mocks.getTelemetry.mockResolvedValue(mockTelemetryConnected);
  mocks.setLedColor.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArduinoPanel', () => {
  it('renders live telemetry cards and connected status badge', async () => {
    render(<ArduinoPanel pollIntervalMs={60000} />);

    await waitFor(() => {
      expect(screen.getByTestId('connection-status-badge')).toHaveTextContent('Connected');
    });

    expect(screen.getByTestId('telemetry-card-temperature')).toHaveTextContent('24.5 °C');
    expect(screen.getByTestId('telemetry-card-humidity')).toHaveTextContent('50.2 %');
    expect(screen.getByTestId('telemetry-card-pressure')).toHaveTextContent('1013.3 hPa');
    expect(screen.getByTestId('telemetry-card-light')).toHaveTextContent('320 lux');
    expect(screen.getByTestId('telemetry-card-accelerometer')).toHaveTextContent('0.05 g');
    expect(screen.getByTestId('telemetry-card-accelerometer')).toHaveTextContent('-0.02 g');
    expect(screen.getByTestId('telemetry-card-accelerometer')).toHaveTextContent('9.81 g');
  });

  it('renders disconnected / mock badge when hardware is not connected', async () => {
    mocks.getTelemetry.mockResolvedValue(mockTelemetryDisconnected);
    render(<ArduinoPanel pollIntervalMs={60000} />);

    await waitFor(() => {
      expect(screen.getByTestId('connection-status-badge')).toHaveTextContent('Disconnected / Mock');
    });

    expect(screen.getByTestId('telemetry-card-temperature')).toHaveTextContent('--');
    expect(screen.getByTestId('telemetry-card-humidity')).toHaveTextContent('--');
    expect(screen.getByTestId('telemetry-card-pressure')).toHaveTextContent('--');
  });

  it('triggers manual refresh on refresh button click', async () => {
    render(<ArduinoPanel pollIntervalMs={60000} />);

    await waitFor(() => {
      expect(mocks.getTelemetry).toHaveBeenCalledTimes(1);
    });

    const refreshBtn = screen.getByTestId('refresh-telemetry-btn');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mocks.getTelemetry).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ColorPicker', () => {
  it('renders presets, pattern modes, and sends color on preset click', async () => {
    render(<ColorPicker />);

    expect(screen.getByTestId('preset-green')).toBeInTheDocument();
    expect(screen.getByTestId('preset-red')).toBeInTheDocument();
    expect(screen.getByTestId('preset-blue')).toBeInTheDocument();
    expect(screen.getByTestId('preset-purple')).toBeInTheDocument();
    expect(screen.getByTestId('preset-orange')).toBeInTheDocument();
    expect(screen.getByTestId('preset-off')).toBeInTheDocument();

    // Click Red preset
    const redBtn = screen.getByTestId('preset-red');
    fireEvent.click(redBtn);

    await waitFor(() => {
      expect(mocks.setLedColor).toHaveBeenCalledWith(255, 0, 0, 'solid');
    });
  });

  it('switches pattern mode and sends update', async () => {
    render(<ColorPicker />);

    const breatheBtn = screen.getByTestId('pattern-breathe');
    fireEvent.click(breatheBtn);

    await waitFor(() => {
      expect(mocks.setLedColor).toHaveBeenCalledWith(0, 255, 0, 'breathe');
    });
  });

  it('sends custom color when Apply button is clicked', async () => {
    render(<ColorPicker />);

    const applyBtn = screen.getByTestId('apply-led-btn');
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(mocks.setLedColor).toHaveBeenCalledWith(0, 255, 0, 'solid');
    });
  });
});
