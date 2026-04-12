'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import type { FaceRigParams } from './rig';
import {
  type SpringState,
  stepSpring,
  isSettled,
  createSpringsFromRig,
  SPRING_PRESETS,
  SPRING_PARAM_KEYS,
} from './spring';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed time step for physics (60fps). */
const DT = 1 / 60;

/** Debounce for boolean props — avoid flicker on threshold crossings. */
const BOOL_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Takes a target FaceRigParams (from expression scoring) and returns an
 * interpolated rig that moves toward the target via spring physics.
 *
 * Uses requestAnimationFrame internally; auto-stops when settled.
 */
export function useSpringRig(targetRig: FaceRigParams): FaceRigParams {
  // Mutable spring states — survives re-renders without causing them.
  const springsRef = useRef<Record<string, SpringState> | null>(null);

  // We only use state for the output rig (triggers re-render → SVG update).
  const [outputRig, setOutputRig] = useState<FaceRigParams>(targetRig);

  // RAF id for cleanup.
  const rafRef = useRef<number>(0);
  const isRunningRef = useRef(false);

  // Target ref — kept mutable so the RAF callback always reads the latest.
  const targetRef = useRef<FaceRigParams>(targetRig);
  targetRef.current = targetRig;

  // Boolean debounce timestamps.
  const boolTimersRef = useRef<{ sweat: number; sparkle: number }>({
    sweat: 0,
    sparkle: 0,
  });

  // -----------------------------------------------------------------------
  // Init springs on first render
  // -----------------------------------------------------------------------
  if (!springsRef.current) {
    springsRef.current = createSpringsFromRig(
      targetRig as unknown as Record<string, number | boolean>,
    );
  }

  // -----------------------------------------------------------------------
  // Animation loop
  // -----------------------------------------------------------------------
  const tick = useCallback(() => {
    const springs = springsRef.current!;
    const target = targetRef.current;
    let allSettled = true;

    // Step numeric springs.
    for (const key of SPRING_PARAM_KEYS) {
      const cfg = SPRING_PRESETS[key];
      const targetVal = target[key as keyof FaceRigParams] as number;
      const next = stepSpring(springs[key], targetVal, cfg, DT);
      springs[key] = next;

      if (!isSettled(next, targetVal)) {
        allSettled = false;
      }
    }

    // Resolve boolean params with debounce.
    const now = Date.now();
    const resolveBoolean = (
      paramKey: 'sweat' | 'sparkle',
      targetVal: boolean,
      currentVal: boolean,
    ): boolean => {
      if (targetVal === currentVal) return currentVal;
      if (now - boolTimersRef.current[paramKey] > BOOL_DEBOUNCE_MS) {
        boolTimersRef.current[paramKey] = now;
        return targetVal;
      }
      return currentVal;
    };

    // Build output rig from spring positions.
    setOutputRig((prev) => {
      const next: FaceRigParams = {
        eyeOpenness: springs.eyeOpenness.position,
        mouthSmile: springs.mouthSmile.position,
        mouthOpen: springs.mouthOpen.position,
        browConcern: springs.browConcern.position,
        browAsymmetry: springs.browAsymmetry.position,
        headTilt: springs.headTilt.position,
        blush: springs.blush.position,
        sweat: resolveBoolean('sweat', target.sweat, prev.sweat),
        sparkle: resolveBoolean('sparkle', target.sparkle, prev.sparkle),
      };
      return next;
    });

    if (allSettled) {
      isRunningRef.current = false;
      // Don't schedule another frame — we're done until target changes.
      return;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // -----------------------------------------------------------------------
  // Start/restart loop when target changes
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!isRunningRef.current) {
      isRunningRef.current = true;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [targetRig, tick]);

  // -----------------------------------------------------------------------
  // Cleanup on unmount
  // -----------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return outputRig;
}
