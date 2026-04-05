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
}

const RIG_BY_STATE: Record<ExpressionState, FaceRigParams> = {
  idle: {
    eyeOpenness: 0.55,
    mouthSmile: 0.35,
    mouthOpen: 0,
    browConcern: 0,
    browAsymmetry: 0,
    headTilt: 0,
    blush: 0,
    sweat: false,
    sparkle: false,
  },
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
};

export function getRigForExpression(state: ExpressionState, intensity = 0.5): FaceRigParams {
  const base = RIG_BY_STATE[state];
  const k = Math.min(1, Math.max(0, intensity));
  return {
    ...base,
    blush: base.blush * k,
  };
}
