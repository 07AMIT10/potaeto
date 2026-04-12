'use client';

import type { FaceRigParams } from '@/lib/expressions/rig';

interface PotatoRigProps {
  rig: FaceRigParams;
  size?: number;
  className?: string;
  motionClass?: string;
}

function Sparkle({ x, y }: { x: number; y: number }) {
  return (
    <g className="animate-potato-sparkle">
      <line x1={x} y1={y - 2} x2={x} y2={y + 2} stroke="#F59E0B" strokeWidth="0.8" strokeLinecap="round" />
      <line x1={x - 2} y1={y} x2={x + 2} y2={y} stroke="#F59E0B" strokeWidth="0.8" strokeLinecap="round" />
    </g>
  );
}

function SweatDrop({ x, y }: { x: number; y: number }) {
  return (
    <ellipse cx={x} cy={y} rx={1} ry={1.5} fill="#93C5FD" opacity={0.7} className="animate-potato-sweat" />
  );
}

export function PotatoRig({ rig, size = 40, className = '', motionClass = '' }: PotatoRigProps) {
  const gazeX = rig.gazeX ?? 0;
  const gazeY = rig.gazeY ?? 0;

  const lx = 14;
  const rx = 26;
  const baseY = 16 + rig.headTilt * 0.8;
  const eyeRy = 0.7 + rig.eyeOpenness * 1.8;
  const eyeRx = 1.6 + rig.eyeOpenness * 0.6;

  // Effective mouth open (respects talking override).
  const effectiveMouthOpen = Math.max(rig.mouthOpen, rig.mouthOpenOverride ?? 0);

  const mouthY = 24 - effectiveMouthOpen * 2.5;
  const curveLift = rig.mouthSmile * 4;
  const mouthPath = `M 15 ${mouthY} Q 20 ${mouthY + curveLift} 25 ${mouthY}`;
  const mouthFill = effectiveMouthOpen > 0.25 ? '#8B5E3C' : 'none';

  const leftBrowY = 12 + rig.browConcern * 1.2;
  const rightBrowY = 12 + rig.browConcern * 1.2 + rig.browAsymmetry * 2.5;
  const leftBrowPath = `M 11 ${leftBrowY + 0.5} Q 14 ${leftBrowY - 1 + rig.browConcern} 17 ${leftBrowY}`;
  const rightBrowPath = `M 23 ${rightBrowY - 0.5 + rig.browAsymmetry} Q 26 ${rightBrowY - 2 + rig.browConcern} 29 ${rightBrowY + rig.browAsymmetry}`;

  // Gaze offsets for pupils.
  const pupilOffsetX = gazeX * 1.5;
  const pupilOffsetY = gazeY * 1.0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`${motionClass} ${className}`}
      role="img"
      aria-hidden
    >
      {/* Body */}
      <ellipse
        cx="20"
        cy="21"
        rx="15"
        ry="14"
        fill="#D4A574"
        stroke="#B8956A"
        strokeWidth="0.8"
        style={{ transform: `rotate(${rig.headTilt * 4}deg)`, transformOrigin: '20px 21px' }}
      />
      <ellipse cx="20" cy="21" rx="13" ry="12" fill="#DCBA8A" opacity={0.3} />

      {/* Brows */}
      {(rig.browConcern > 0.08 || rig.browAsymmetry > 0.08) && (
        <>
          <path d={leftBrowPath} fill="none" stroke="#6B4E3D" strokeWidth="1.2" strokeLinecap="round" />
          <path d={rightBrowPath} fill="none" stroke="#6B4E3D" strokeWidth="1.2" strokeLinecap="round" />
        </>
      )}

      {/* Eyes (pupils shift with gaze) */}
      <ellipse cx={lx + pupilOffsetX} cy={baseY + pupilOffsetY} rx={eyeRx} ry={eyeRy} fill="#3D2B1F" />
      <ellipse cx={rx + pupilOffsetX} cy={baseY + rig.browAsymmetry * 0.8 + pupilOffsetY} rx={eyeRx} ry={eyeRy} fill="#3D2B1F" />

      {/* Eye highlights (shifted with gaze for parallax) */}
      <circle cx={lx + 0.5 + pupilOffsetX * 0.6} cy={baseY - 0.5 + pupilOffsetY * 0.4} r={0.6} fill="white" opacity={0.7} />
      <circle cx={rx + 0.5 + pupilOffsetX * 0.6} cy={baseY + rig.browAsymmetry * 0.8 - 0.5 + pupilOffsetY * 0.4} r={0.6} fill="white" opacity={0.7} />

      {/* Mouth */}
      <path
        d={mouthPath}
        fill={mouthFill}
        stroke="#6B4E3D"
        strokeWidth="1.2"
        strokeLinecap="round"
      />

      {/* Blush */}
      {rig.blush > 0.05 && (
        <>
          <ellipse cx={10} cy={20} rx={2.5} ry={1.2} fill="#F4A6A0" opacity={0.25 + rig.blush * 0.55} />
          <ellipse cx={30} cy={20} rx={2.5} ry={1.2} fill="#F4A6A0" opacity={0.25 + rig.blush * 0.55} />
        </>
      )}

      {/* Extras */}
      {rig.sweat && <SweatDrop x={31} y={13} />}
      {rig.sparkle && (
        <>
          <Sparkle x={6} y={8} />
          <Sparkle x={34} y={10} />
        </>
      )}
    </svg>
  );
}
