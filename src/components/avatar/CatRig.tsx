'use client';

import type { FaceRigParams } from '@/lib/expressions/rig';

interface CatRigProps {
  rig: FaceRigParams;
  size?: number;
  className?: string;
  motionClass?: string;
}

/** Same rig params as potato; different silhouette — proves template extensibility. */
export function CatRig({ rig, size = 40, className = '', motionClass = '' }: CatRigProps) {
  const cx = 20;
  const faceY = 22;
  const eyeY = 19 + rig.headTilt * 0.5;
  const eyeRy = 0.9 + rig.eyeOpenness * 1.4;
  const eyeRx = 1.4 + rig.eyeOpenness * 0.5;
  const mouthY = 26 - rig.mouthOpen * 2;
  const smile = rig.mouthSmile * 3;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`transition-all duration-300 ease-in-out ${motionClass} ${className}`}
      role="img"
      aria-hidden
    >
      {/* Ears */}
      <path d="M 8 18 L 12 8 L 16 16 Z" fill="#9CA3AF" stroke="#6B7280" strokeWidth="0.6" />
      <path d="M 24 16 L 28 8 L 32 18 Z" fill="#9CA3AF" stroke="#6B7280" strokeWidth="0.6" />

      {/* Head */}
      <ellipse cx={cx} cy={faceY} rx="14" ry="12" fill="#D1D5DB" stroke="#9CA3AF" strokeWidth="0.8" />

      {/* Whiskers */}
      <line x1="4" y1={faceY + 2} x2="12" y2={faceY + 1} stroke="#9CA3AF" strokeWidth="0.5" />
      <line x1="4" y1={faceY + 5} x2="12" y2={faceY + 4} stroke="#9CA3AF" strokeWidth="0.5" />
      <line x1="36" y1={faceY + 2} x2="28" y2={faceY + 1} stroke="#9CA3AF" strokeWidth="0.5" />
      <line x1="36" y1={faceY + 5} x2="28" y2={faceY + 4} stroke="#9CA3AF" strokeWidth="0.5" />

      {/* Eyes */}
      <ellipse cx={14} cy={eyeY} rx={eyeRx} ry={eyeRy} fill="#1F2937" />
      <ellipse cx={26} cy={eyeY + rig.browAsymmetry} rx={eyeRx} ry={eyeRy} fill="#1F2937" />
      <circle cx={14.5} cy={eyeY - 0.4} r={0.5} fill="white" opacity={0.85} />
      <circle cx={26.5} cy={eyeY + rig.browAsymmetry - 0.4} r={0.5} fill="white" opacity={0.85} />

      {/* Nose */}
      <path d="M 20 23 L 18 25 L 22 25 Z" fill="#F472B6" />

      {/* Mouth */}
      <path
        d={`M 16 ${mouthY} Q 20 ${mouthY + smile} 24 ${mouthY}`}
        fill={rig.mouthOpen > 0.3 ? '#374151' : 'none'}
        stroke="#374151"
        strokeWidth="1"
        strokeLinecap="round"
      />

      {rig.blush > 0.05 && (
        <>
          <ellipse cx={11} cy={22} rx={2} ry={1} fill="#FDA4AF" opacity={0.35 + rig.blush * 0.45} />
          <ellipse cx={29} cy={22} rx={2} ry={1} fill="#FDA4AF" opacity={0.35 + rig.blush * 0.45} />
        </>
      )}

      {rig.sweat && (
        <ellipse cx={32} cy={14} rx={0.9} ry={1.3} fill="#93C5FD" opacity={0.75} className="animate-potato-sweat" />
      )}
      {rig.sparkle && (
        <g className="animate-potato-sparkle">
          <line x1={6} y1={10} x2={6} y2={14} stroke="#FBBF24" strokeWidth="0.7" strokeLinecap="round" />
          <line x1={4} y1={12} x2={8} y2={12} stroke="#FBBF24" strokeWidth="0.7" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
