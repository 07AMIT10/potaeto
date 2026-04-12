import type { ExpressionState } from './types';

/**
 * Normalized face parameters shared by all avatar templates.
 * Each template maps these to its own geometry (potato, cat, robot, …).
 */
export interface FaceRigParams {
  /** 0 = heavy squint, 1 = wide eyes */
  eyeOpenness: number;
  /** -1 = downturned mouth, 0 = neutral, 1 = strong smile */
  mouthSmile: number;
  /** 0 = closed, 1 = open / talking */
  mouthOpen: number;
  /** 0 = relaxed brows, 1 = worried / furrowed */
  browConcern: number;
  /** 0 = symmetric, 1 = strong asymmetry (confused) */
  browAsymmetry: number;
  /** -1..1 tilt in arbitrary units (template interprets as degrees or skew) */
  headTilt: number;
  /** 0..1 blush strength */
  blush: number;
  sweat: boolean;
  sparkle: boolean;
  /** -1..1 horizontal gaze offset (left/right); 0 = center */
  gazeX?: number;
  /** -1..1 vertical gaze offset (up/down); 0 = center */
  gazeY?: number;
  /** 0..1 mouth-open override from talking animation */
  mouthOpenOverride?: number;
}

const IDLE_RIG: FaceRigParams = {
  eyeOpenness: 0.55,
  mouthSmile: 0.35,
  mouthOpen: 0,
  browConcern: 0,
  browAsymmetry: 0,
  headTilt: 0,
  blush: 0,
  sweat: false,
  sparkle: false,
};

const RIG_BY_STATE: Record<ExpressionState, FaceRigParams> = {
  idle: { ...IDLE_RIG },

  happy: {
    eyeOpenness: 0.45,
    mouthSmile: 0.95,
    mouthOpen: 0.08,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0.65,
    sweat: false,
    sparkle: false,
  },
  amused: {
    eyeOpenness: 0.35,
    mouthSmile: 0.85,
    mouthOpen: 0.45,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
  thoughtful: {
    eyeOpenness: 0.6,
    mouthSmile: 0.05,
    mouthOpen: 0,
    browConcern: 0.25,
    browAsymmetry: 0.15,
    headTilt: -0.35,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
  concerned: {
    eyeOpenness: 0.65,
    mouthSmile: -0.45,
    mouthOpen: 0,
    browConcern: 0.85,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0,
    sweat: true,
    sparkle: false,
  },
  sad: {
    eyeOpenness: 0.4,
    mouthSmile: -0.7,
    mouthOpen: 0,
    browConcern: 0.55,
    browAsymmetry: 0,
    headTilt: 0.1,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
  excited: {
    eyeOpenness: 0.95,
    mouthSmile: 0.9,
    mouthOpen: 0.55,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0,
    sweat: false,
    sparkle: true,
  },
  confused: {
    eyeOpenness: 0.7,
    mouthSmile: 0,
    mouthOpen: 0,
    browConcern: 0.2,
    browAsymmetry: 0.85,
    headTilt: 0,
    blush: 0,
    sweat: false,
    sparkle: false,
  },

  // -----------------------------------------------------------------------
  // New expression states (v2)
  // -----------------------------------------------------------------------

  angry: {
    eyeOpenness: 0.3,
    mouthSmile: -0.8,
    mouthOpen: 0.15,
    browConcern: 0.95,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0.2,
    sweat: false,
    sparkle: false,
  },
  surprised: {
    eyeOpenness: 1.0,
    mouthSmile: 0.1,
    mouthOpen: 0.7,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
  shy: {
    eyeOpenness: 0.35,
    mouthSmile: 0.3,
    mouthOpen: 0,
    browConcern: 0.1,
    browAsymmetry: 0,
    headTilt: 0.25,
    blush: 0.9,
    sweat: false,
    sparkle: false,
  },
  proud: {
    eyeOpenness: 0.5,
    mouthSmile: 0.7,
    mouthOpen: 0,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: -0.15,
    blush: 0.2,
    sweat: false,
    sparkle: true,
  },
  sleepy: {
    eyeOpenness: 0.15,
    mouthSmile: 0.1,
    mouthOpen: 0.3,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0.3,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
  loving: {
    eyeOpenness: 0.4,
    mouthSmile: 0.85,
    mouthOpen: 0.05,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0.1,
    blush: 0.85,
    sweat: false,
    sparkle: true,
  },
  mischievous: {
    eyeOpenness: 0.45,
    mouthSmile: 0.6,
    mouthOpen: 0.1,
    browConcern: 0,
    browAsymmetry: 0.5,
    headTilt: -0.2,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
  nervous: {
    eyeOpenness: 0.8,
    mouthSmile: -0.2,
    mouthOpen: 0.05,
    browConcern: 0.7,
    browAsymmetry: 0.2,
    headTilt: 0,
    blush: 0.15,
    sweat: true,
    sparkle: false,
  },
};

/**
 * Map an expression state + intensity to a full FaceRigParams.
 * Intensity (0..1) scales ALL numeric parameters toward idle baseline —
 * so intensity=0 → idle face, intensity=1 → full expression.
 */
export function getRigForExpression(state: ExpressionState, intensity = 0.5): FaceRigParams {
  const target = RIG_BY_STATE[state];
  const idle = IDLE_RIG;
  const k = Math.min(1, Math.max(0, intensity));

  return {
    eyeOpenness: lerp(idle.eyeOpenness, target.eyeOpenness, k),
    mouthSmile: lerp(idle.mouthSmile, target.mouthSmile, k),
    mouthOpen: lerp(idle.mouthOpen, target.mouthOpen, k),
    browConcern: lerp(idle.browConcern, target.browConcern, k),
    browAsymmetry: lerp(idle.browAsymmetry, target.browAsymmetry, k),
    headTilt: lerp(idle.headTilt, target.headTilt, k),
    blush: lerp(idle.blush, target.blush, k),
    sweat: k > 0.4 ? target.sweat : idle.sweat,
    sparkle: k > 0.4 ? target.sparkle : idle.sparkle,
  };
}

/** Linear interpolation between two values. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
