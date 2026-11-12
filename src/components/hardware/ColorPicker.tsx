'use client';

import { useCallback, useState } from 'react';
import { CoreClient } from '@/lib/core/client';
import { coreBaseUrl, useCore } from '@/components/providers/CoreProvider';

export type LedPattern = 'solid' | 'breathe' | 'blink';

export interface ColorPreset {
  name: string;
  r: number;
  g: number;
  b: number;
  hex: string;
}

export const PRESET_COLORS: ColorPreset[] = [
  { name: 'Green', r: 0, g: 255, b: 0, hex: '#00ff00' },
  { name: 'Red', r: 255, g: 0, b: 0, hex: '#ff0000' },
  { name: 'Blue', r: 0, g: 128, b: 255, hex: '#0080ff' },
  { name: 'Purple', r: 180, g: 0, b: 255, hex: '#b400ff' },
  { name: 'Orange', r: 255, g: 128, b: 0, hex: '#ff8000' },
  { name: 'Off', r: 0, g: 0, b: 0, hex: '#000000' },
];

export interface ColorPickerProps {
  client?: CoreClient;
  onColorSent?: (color: { r: number; g: number; b: number; pattern: LedPattern }) => void;
  className?: string;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const sanitized = hex.replace('#', '');
  if (sanitized.length !== 6) return { r: 0, g: 0, b: 0 };
  const r = parseInt(sanitized.slice(0, 2), 16) || 0;
  const g = parseInt(sanitized.slice(2, 4), 16) || 0;
  const b = parseInt(sanitized.slice(4, 6), 16) || 0;
  return { r, g, b };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function ColorPicker({ client: propClient, onColorSent, className = '' }: ColorPickerProps) {
  let fallbackClient: CoreClient | null = null;
  try {
    const core = useCore();
    fallbackClient = core.client;
  } catch {
    // Rendered outside CoreProvider (e.g. testing or standalone)
    fallbackClient = null;
  }
  const client = propClient || fallbackClient || new CoreClient({ baseUrl: coreBaseUrl() });

  const [r, setR] = useState(0);
  const [g, setG] = useState(255);
  const [b, setB] = useState(0);
  const [pattern, setPattern] = useState<LedPattern>('solid');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const sendColor = useCallback(
    async (newR: number, newG: number, newB: number, newPattern: LedPattern) => {
      setSending(true);
      setStatus(null);
      try {
        const res = await client.setLedColor(newR, newG, newB, newPattern);
        if (res.ok) {
          setStatus({ type: 'success', message: 'LED command sent successfully' });
          onColorSent?.({ r: newR, g: newG, b: newB, pattern: newPattern });
        } else {
          setStatus({
            type: 'error',
            message: res.error || 'Device not connected or command failed',
          });
        }
      } catch (err) {
        setStatus({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to update LED',
        });
      } finally {
        setSending(false);
      }
    },
    [client, onColorSent],
  );

  const handlePresetClick = (preset: ColorPreset) => {
    setR(preset.r);
    setG(preset.g);
    setB(preset.b);
    void sendColor(preset.r, preset.g, preset.b, pattern);
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rgb = hexToRgb(e.target.value);
    setR(rgb.r);
    setG(rgb.g);
    setB(rgb.b);
  };

  const handlePatternChange = (newPattern: LedPattern) => {
    setPattern(newPattern);
    void sendColor(r, g, b, newPattern);
  };

  const isOff = r === 0 && g === 0 && b === 0;
  const currentHex = rgbToHex(r, g, b);

  return (
    <div className={`card p-5 space-y-5 ${className}`} data-testid="arduino-color-picker">
      <div className="flex items-center justify-between border-b border-[var(--card-border)] pb-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--foreground)]">LED Control</h3>
          <p className="text-xs text-[var(--muted)]">Onboard active-low RGB LED</p>
        </div>
        {/* Glow Preview Indicator */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-[var(--muted)] uppercase">{currentHex}</span>
          <div
            data-testid="led-preview"
            className={`w-7 h-7 rounded-full border border-black/10 dark:border-white/20 transition-all duration-300 ${
              pattern === 'breathe' && !isOff ? 'animate-pulse' : ''
            } ${pattern === 'blink' && !isOff ? 'animate-bounce' : ''}`}
            style={{
              backgroundColor: isOff ? '#1c1917' : `rgb(${r}, ${g}, ${b})`,
              boxShadow: isOff
                ? 'none'
                : `0 0 12px rgba(${r}, ${g}, ${b}, 0.8), 0 0 24px rgba(${r}, ${g}, ${b}, 0.4)`,
            }}
            title={`RGB(${r}, ${g}, ${b}) - ${pattern}`}
          />
        </div>
      </div>

      {/* Palette Presets */}
      <div>
        <label className="label text-xs uppercase tracking-wider text-[var(--muted)]">
          Palette Presets
        </label>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {PRESET_COLORS.map((preset) => {
            const active = r === preset.r && g === preset.g && b === preset.b;
            return (
              <button
                key={preset.name}
                type="button"
                data-testid={`preset-${preset.name.toLowerCase()}`}
                onClick={() => handlePresetClick(preset)}
                disabled={sending}
                className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-all text-xs font-medium ${
                  active
                    ? 'border-potato-500 bg-potato-50 dark:bg-potato-950/40 shadow-sm'
                    : 'border-[var(--card-border)] hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <span
                  className="w-5 h-5 rounded-full border border-black/10 dark:border-white/20 shadow-xs"
                  style={{
                    backgroundColor: preset.hex,
                    boxShadow:
                      preset.hex !== '#000000'
                        ? `0 0 6px ${preset.hex}`
                        : 'none',
                  }}
                />
                <span className="text-[var(--foreground)]">{preset.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Pattern Selector */}
      <div>
        <label className="label text-xs uppercase tracking-wider text-[var(--muted)]">
          Pattern Mode
        </label>
        <div className="grid grid-cols-3 gap-2">
          {(['solid', 'breathe', 'blink'] as const).map((p) => {
            const active = pattern === p;
            return (
              <button
                key={p}
                type="button"
                data-testid={`pattern-${p}`}
                onClick={() => handlePatternChange(p)}
                disabled={sending}
                className={`py-2 px-3 rounded-xl border text-xs font-semibold capitalize transition-all ${
                  active
                    ? 'bg-potato-500 text-white border-potato-600 shadow-sm'
                    : 'border-[var(--card-border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom Color Slider / Hex Picker */}
      <div className="space-y-3 pt-1 border-t border-[var(--card-border)]">
        <div className="flex items-center justify-between">
          <label className="label text-xs uppercase tracking-wider text-[var(--muted)] m-0">
            Custom RGB Channels
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              aria-label="Pick custom color"
              value={currentHex}
              onChange={handleHexChange}
              className="w-7 h-7 rounded-lg cursor-pointer border border-[var(--card-border)] bg-transparent p-0"
            />
          </div>
        </div>

        {/* RGB Sliders */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-red-500 w-4">R</span>
            <input
              type="range"
              min="0"
              max="255"
              value={r}
              onChange={(e) => setR(Number(e.target.value))}
              aria-label="Red channel"
              className="flex-1 accent-red-500 h-1.5 bg-red-100 dark:bg-red-950 rounded-lg cursor-pointer"
            />
            <span className="text-xs font-mono w-8 text-right text-[var(--muted)]">{r}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-green-500 w-4">G</span>
            <input
              type="range"
              min="0"
              max="255"
              value={g}
              onChange={(e) => setG(Number(e.target.value))}
              aria-label="Green channel"
              className="flex-1 accent-green-500 h-1.5 bg-green-100 dark:bg-green-950 rounded-lg cursor-pointer"
            />
            <span className="text-xs font-mono w-8 text-right text-[var(--muted)]">{g}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-blue-500 w-4">B</span>
            <input
              type="range"
              min="0"
              max="255"
              value={b}
              onChange={(e) => setB(Number(e.target.value))}
              aria-label="Blue channel"
              className="flex-1 accent-blue-500 h-1.5 bg-blue-100 dark:bg-blue-950 rounded-lg cursor-pointer"
            />
            <span className="text-xs font-mono w-8 text-right text-[var(--muted)]">{b}</span>
          </div>
        </div>

        <div className="pt-2 flex items-center justify-between">
          <button
            type="button"
            data-testid="apply-led-btn"
            onClick={() => void sendColor(r, g, b, pattern)}
            disabled={sending}
            className="btn-primary w-full text-xs py-2"
          >
            {sending ? 'Sending to Arduino...' : `Apply RGB(${r}, ${g}, ${b}) [${pattern}]`}
          </button>
        </div>
      </div>

      {/* Status Feedback Toast/Message */}
      {status && (
        <div
          role="status"
          className={`p-2.5 rounded-xl text-xs flex items-center justify-between ${
            status.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
              : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
          }`}
        >
          <span>{status.message}</span>
          <button
            type="button"
            onClick={() => setStatus(null)}
            className="text-xs font-bold px-1.5 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
