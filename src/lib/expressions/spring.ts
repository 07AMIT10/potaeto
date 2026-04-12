/**
 * Spring physics engine for smooth SVG expression transitions.
 *
 * Uses a Damped Harmonic Oscillator (Hooke's Law):
 *   F = -stiffness × (x - target) - damping × velocity
 *   acceleration = F / mass
 *   velocity += acceleration × dt
 *   x += velocity × dt
 *
 * Each FaceRigParams numeric field has its own spring with tuned feel.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpringState {
  position: number;
  velocity: number;
}

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

// ---------------------------------------------------------------------------
// Core step — single Euler integration tick
// ---------------------------------------------------------------------------

/**
 * Advance a single spring by one time step (semi-implicit Euler).
 * Pure function — no side effects.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dt: number,
): SpringState {
  const displacement = state.position - target;
  const springForce = -config.stiffness * displacement;
  const dampingForce = -config.damping * state.velocity;
  const acceleration = (springForce + dampingForce) / config.mass;

  const nextVelocity = state.velocity + acceleration * dt;
  const nextPosition = state.position + nextVelocity * dt;

  return { position: nextPosition, velocity: nextVelocity };
}

// ---------------------------------------------------------------------------
// Settling check
// ---------------------------------------------------------------------------

const DEFAULT_POSITION_THRESHOLD = 0.001;
const DEFAULT_VELOCITY_THRESHOLD = 0.001;

/**
 * Returns true when the spring is close enough to target with near-zero
 * velocity — safe to stop the animation loop for this param.
 */
export function isSettled(
  state: SpringState,
  target: number,
  positionThreshold = DEFAULT_POSITION_THRESHOLD,
  velocityThreshold = DEFAULT_VELOCITY_THRESHOLD,
): boolean {
  return (
    Math.abs(state.position - target) < positionThreshold &&
    Math.abs(state.velocity) < velocityThreshold
  );
}

// ---------------------------------------------------------------------------
// Per-parameter spring presets
// ---------------------------------------------------------------------------

/**
 * Tuning presets — each facial parameter has a different "feel":
 * - Eyes: snappy (high stiffness) for quick blinks
 * - Mouth smile: moderate, natural curve change
 * - Mouth open: very snappy for talking animation
 * - Brows: slow, deliberate for emotional shifts
 * - Head tilt: heavier mass, lags slightly for weight
 * - Blush: slow fade in/out
 */
export const SPRING_PRESETS = {
  eyeOpenness:   { stiffness: 180, damping: 18, mass: 1   },
  mouthSmile:    { stiffness: 120, damping: 14, mass: 1   },
  mouthOpen:     { stiffness: 220, damping: 20, mass: 1   },
  browConcern:   { stiffness: 90,  damping: 12, mass: 1   },
  browAsymmetry: { stiffness: 100, damping: 13, mass: 1   },
  headTilt:      { stiffness: 60,  damping: 10, mass: 1.5 },
  blush:         { stiffness: 40,  damping: 8,  mass: 1   },
} as const satisfies Record<string, SpringConfig>;

/** Keys of FaceRigParams that are numeric and spring-animated. */
export const SPRING_PARAM_KEYS = Object.keys(SPRING_PRESETS) as (keyof typeof SPRING_PRESETS)[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an initial SpringState at a given position. */
export function createSpring(initialPosition = 0): SpringState {
  return { position: initialPosition, velocity: 0 };
}

/** Create springs for all numeric rig params from an initial rig. */
export function createSpringsFromRig(
  rig: Record<string, number | boolean>,
): Record<string, SpringState> {
  const springs: Record<string, SpringState> = {};
  for (const key of SPRING_PARAM_KEYS) {
    const val = rig[key];
    springs[key] = createSpring(typeof val === 'number' ? val : 0);
  }
  return springs;
}
