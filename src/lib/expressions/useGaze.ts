'use client';

import { useRef, useCallback, useEffect, useState, type RefObject } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max pixel offset for the pupil. */
const MAX_OFFSET = 1;

/** Smoothing factor — lower = more lag (0..1). */
const SMOOTHING = 0.08;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Tracks the user's cursor position relative to an avatar SVG element and
 * returns normalized gaze direction values.
 *
 * - `gazeX`: –1 (cursor far left) → 0 (centered) → 1 (cursor far right)
 * - `gazeY`: –1 (cursor above) → 0 (centered) → 1 (cursor below)
 *
 * Uses requestAnimationFrame-throttled mousemove for 60fps smoothness.
 * On touch devices or when the avatar ref is null, returns {0, 0}.
 */
export function useGaze(
  avatarRef: RefObject<HTMLElement | SVGElement | null>,
): { gazeX: number; gazeY: number } {
  const [gaze, setGaze] = useState({ gazeX: 0, gazeY: 0 });

  // Mutable state for smooth interpolation (no re-renders).
  const targetRef = useRef({ x: 0, y: 0 });
  const currentRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number>(0);
  const isRunningRef = useRef(false);

  // -----------------------------------------------------------------------
  // Interpolation loop.
  // -----------------------------------------------------------------------
  const tick = useCallback(() => {
    const cur = currentRef.current;
    const tgt = targetRef.current;

    cur.x += (tgt.x - cur.x) * SMOOTHING;
    cur.y += (tgt.y - cur.y) * SMOOTHING;

    // Clamp.
    cur.x = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, cur.x));
    cur.y = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, cur.y));

    setGaze({ gazeX: cur.x, gazeY: cur.y });

    // Keep running — cursor can move anytime.
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // -----------------------------------------------------------------------
  // Mouse event handler.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const el = avatarRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Direction vector, normalized to viewport-relative scale.
      const dx = e.clientX - centerX;
      const dy = e.clientY - centerY;

      // Normalize: clamp to ±1 over a "range" of 300px.
      const range = 300;
      targetRef.current = {
        x: Math.max(-1, Math.min(1, dx / range)),
        y: Math.max(-1, Math.min(1, dy / range)),
      };
    };

    // Use passive listener for performance.
    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    // Start RAF loop.
    if (!isRunningRef.current) {
      isRunningRef.current = true;
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      isRunningRef.current = false;
    };
  }, [avatarRef, tick]);

  return gaze;
}
