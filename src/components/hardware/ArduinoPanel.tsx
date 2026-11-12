'use client';

import { useCallback, useEffect, useState } from 'react';
import { CoreClient } from '@/lib/core/client';
import type { TelemetryData } from '@/lib/core/types';
import { coreBaseUrl, useCore } from '@/components/providers/CoreProvider';
import { ColorPicker } from './ColorPicker';

export interface ArduinoPanelProps {
  client?: CoreClient;
  pollIntervalMs?: number;
  className?: string;
}

export function ArduinoPanel({
  client: propClient,
  pollIntervalMs = 3000,
  className = '',
}: ArduinoPanelProps) {
  let fallbackClient: CoreClient | null = null;
  try {
    const core = useCore();
    fallbackClient = core.client;
  } catch {
    fallbackClient = null;
  }
  const client = propClient || fallbackClient || new CoreClient({ baseUrl: coreBaseUrl() });

  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const fetchTelemetry = useCallback(async () => {
    try {
      const data = await client.getTelemetry();
      setTelemetry(data);
      setError(null);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch telemetry');
      // If error occurs, preserve last known or fall back to disconnected state
      setTelemetry((prev) => prev ? { ...prev, connected: false } : {
        connected: false,
        temperature: null,
        humidity: null,
        pressure: null,
        light: null,
        accelerometer: null,
      });
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchTelemetry();
    const interval = setInterval(() => {
      void fetchTelemetry();
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchTelemetry, pollIntervalMs]);

  const isConnected = telemetry?.connected ?? false;

  return (
    <div className={`space-y-6 max-w-4xl mx-auto w-full ${className}`} data-testid="arduino-panel">
      {/* Top Header Card: Status & Refresh */}
      <div className="card p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-[var(--foreground)] tracking-tight">
              Arduino Nano 33 BLE Sense Rev2
            </h2>
            {/* Connection status badge */}
            <span
              data-testid="connection-status-badge"
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
                isConnected
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-300 dark:border-amber-800'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                }`}
              />
              {isConnected ? 'Connected' : 'Disconnected / Mock'}
            </span>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Serial port: <code className="font-mono text-potato-600 dark:text-potato-400">/dev/potaeto-arduino</code> (115200 baud, Protocol v1)
            {lastRefreshed && (
              <span className="ml-2">
                • Updated: {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>

        <button
          type="button"
          data-testid="refresh-telemetry-btn"
          onClick={() => void fetchTelemetry()}
          disabled={loading}
          className="btn-secondary text-xs px-3.5 py-2 flex items-center gap-1.5"
        >
          <span className={loading ? 'animate-spin' : ''}>🔄</span>
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl text-xs bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800"
        >
          ⚠️ {error}
        </div>
      )}

      {/* Telemetry Sensor Cards Grid */}
      <div>
        <h3 className="section-title text-base mb-3 text-[var(--foreground)]">
          Live Sensor Telemetry
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Temperature */}
          <div
            className="card p-4 space-y-2 hover:border-potato-300 transition-colors"
            data-testid="telemetry-card-temperature"
          >
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span className="text-xs font-medium uppercase tracking-wider">Temperature</span>
              <span className="text-lg" aria-hidden>🌡️</span>
            </div>
            <div className="text-2xl font-bold text-[var(--foreground)]">
              {telemetry?.temperature != null ? `${telemetry.temperature.toFixed(1)} °C` : '--'}
            </div>
            <p className="text-xs text-[var(--muted)]">HTS221 onboard environmental sensor</p>
          </div>

          {/* Relative Humidity */}
          <div
            className="card p-4 space-y-2 hover:border-potato-300 transition-colors"
            data-testid="telemetry-card-humidity"
          >
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span className="text-xs font-medium uppercase tracking-wider">Relative Humidity</span>
              <span className="text-lg" aria-hidden>💧</span>
            </div>
            <div className="text-2xl font-bold text-[var(--foreground)]">
              {telemetry?.humidity != null ? `${telemetry.humidity.toFixed(1)} %` : '--'}
            </div>
            <p className="text-xs text-[var(--muted)]">Relative humidity measurement</p>
          </div>

          {/* Atmospheric Pressure */}
          <div
            className="card p-4 space-y-2 hover:border-potato-300 transition-colors"
            data-testid="telemetry-card-pressure"
          >
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span className="text-xs font-medium uppercase tracking-wider">Atmospheric Pressure</span>
              <span className="text-lg" aria-hidden>📊</span>
            </div>
            <div className="text-2xl font-bold text-[var(--foreground)]">
              {telemetry?.pressure != null ? `${telemetry.pressure.toFixed(1)} hPa` : '--'}
            </div>
            <p className="text-xs text-[var(--muted)]">LPS22HB barometric pressure sensor</p>
          </div>

          {/* Light Level */}
          <div
            className="card p-4 space-y-2 hover:border-potato-300 transition-colors"
            data-testid="telemetry-card-light"
          >
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span className="text-xs font-medium uppercase tracking-wider">Light Level</span>
              <span className="text-lg" aria-hidden>☀️</span>
            </div>
            <div className="text-2xl font-bold text-[var(--foreground)]">
              {telemetry?.light != null ? `${telemetry.light} lux` : '--'}
            </div>
            <p className="text-xs text-[var(--muted)]">APDS9960 gesture & ambient lux sensor</p>
          </div>

          {/* Accelerometer */}
          <div
            className="card p-4 space-y-2 hover:border-potato-300 transition-colors sm:col-span-2 lg:col-span-2"
            data-testid="telemetry-card-accelerometer"
          >
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span className="text-xs font-medium uppercase tracking-wider">3-Axis Accelerometer</span>
              <span className="text-lg" aria-hidden>🧭</span>
            </div>
            <div className="text-lg font-bold text-[var(--foreground)]">
              {telemetry?.accelerometer && Array.isArray(telemetry.accelerometer) ? (
                <div className="grid grid-cols-3 gap-3 font-mono text-sm py-1">
                  <div className="bg-black/5 dark:bg-white/5 rounded-lg p-2 text-center">
                    <span className="text-xs text-[var(--muted)] block">X axis</span>
                    <span className="text-potato-600 dark:text-potato-400 font-semibold">
                      {telemetry.accelerometer[0]?.toFixed(2) ?? '0.00'} g
                    </span>
                  </div>
                  <div className="bg-black/5 dark:bg-white/5 rounded-lg p-2 text-center">
                    <span className="text-xs text-[var(--muted)] block">Y axis</span>
                    <span className="text-potato-600 dark:text-potato-400 font-semibold">
                      {telemetry.accelerometer[1]?.toFixed(2) ?? '0.00'} g
                    </span>
                  </div>
                  <div className="bg-black/5 dark:bg-white/5 rounded-lg p-2 text-center">
                    <span className="text-xs text-[var(--muted)] block">Z axis</span>
                    <span className="text-potato-600 dark:text-potato-400 font-semibold">
                      {telemetry.accelerometer[2]?.toFixed(2) ?? '0.00'} g
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-2xl font-bold">--</div>
              )}
            </div>
            <p className="text-xs text-[var(--muted)]">BMI270 6-axis IMU accelerometer vector</p>
          </div>
        </div>
      </div>

      {/* Embedded LED Control Section */}
      <div>
        <ColorPicker client={client} />
      </div>
    </div>
  );
}
