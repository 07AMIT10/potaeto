'use client';

import { useRef, useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spring config for talking mouth — very snappy for crisp open/close. */
const STIFFNESS = 300;
const DAMPING = 25;
const MASS = 1;
const DT = 1 / 60;

/** Jitter range for organic feel. */
const JITTER_RANGE = 0.03;

/** How long (ms) after streaming stops before mouth fully closes. */
const DECAY_MS = 400;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Drives a mouth-open value (0..1) that responds to streaming token arrival.
 *
 * During streaming: converts chunk length into a mouth-open target and
 * smoothly tracks it via spring physics with micro-jitter.
 *
 * After streaming: decays to 0 over DECAY_MS.
 *
 * @param isStreaming - Whether tokens are currently arriving.
 * @param latestChunkLength - Length of the most recently received text chunk.
 * @returns mouthOpen value [0..1] to overlay on the expression rig.
 */
export function useTalkingMouth(
  isStreaming: boolean,
  latestChunkLength: number,
): number {
  const [mouthOpen, setMouthOpen] = useState(0);
  const stateRef = useRef({ position: 0, velocity: 0 });
  const targetRef = useRef(0);
  const rafRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -----------------------------------------------------------------------
  // Update target based on chunk size.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (isStreaming && latestChunkLength > 0) {
      // Map chunk size to mouth aperture (bigger chunks = wider mouth).
      const raw = Math.min(latestChunkLength / 15, 0.8);
      const jitter = (Math.random() - 0.5) * 2 * JITTER_RANGE;
      targetRef.current = Math.max(0.1, raw + jitter);
    }
  }, [isStreaming, latestChunkLength]);

  // -----------------------------------------------------------------------
  // Spring tick.
  // -----------------------------------------------------------------------
  const tick = useCallback(() => {
    const s = stateRef.current;
    const target = targetRef.current;

    const displacement = s.position - target;
    const springForce = -STIFFNESS * displacement;
    const dampingForce = -DAMPING * s.velocity;
    const acceleration = (springForce + dampingForce) / MASS;

    s.velocity += acceleration * DT;
    s.position += s.velocity * DT;

    // Clamp.
    s.position = Math.max(0, Math.min(1, s.position));

    setMouthOpen(s.position);

    // Stop when settled on 0 (idle).
    const settled =
      Math.abs(s.position - target) < 0.005 &&
      Math.abs(s.velocity) < 0.005;

    if (settled && target === 0) {
      isRunningRef.current = false;
      setMouthOpen(0);
      return;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // -----------------------------------------------------------------------
  // Start/stop animation loop.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (isStreaming) {
      // Clear any pending decay.
      if (decayTimerRef.current) {
        clearTimeout(decayTimerRef.current);
        decayTimerRef.current = null;
      }

      if (!isRunningRef.current) {
        isRunningRef.current = true;
        rafRef.current = requestAnimationFrame(tick);
      }
    } else {
      // Streaming stopped — decay to 0 after delay.
      targetRef.current = 0;
      decayTimerRef.current = setTimeout(() => {
        targetRef.current = 0;
      }, DECAY_MS);
    }
  }, [isStreaming, tick]);

  // -----------------------------------------------------------------------
  // Cleanup.
  // -----------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
    };
  }, []);

  return mouthOpen;
}
