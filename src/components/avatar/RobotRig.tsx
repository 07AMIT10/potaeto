'use client';

import type { FaceRigParams } from '@/lib/expressions/rig';

interface RobotRigProps {
  rig: FaceRigParams;
  size?: number;
  className?: string;
  motionClass?: string;
}

/**
 * Robot avatar template — friendly, warm-toned to match the Potaeto brand.
 * Copper/bronze metallic body, rounded square head, LED-style eyes with
 * soft glow, pixel-esque mouth, and a small antenna.
 *
 * Uses the same FaceRigParams interface as Potato and Cat.
 */
export function RobotRig({ rig, size = 40, className = '', motionClass = '' }: RobotRigProps) {
  const gazeX = rig.gazeX ?? 0;
  const gazeY = rig.gazeY ?? 0;

  // Eye parameters.
  const eyeY = 17 + rig.headTilt * 0.5;
  const eyeHeight = 2 + rig.eyeOpenness * 3;
  const eyeWidth = 4;

  // Effective mouth open.
  const effectiveMouthOpen = Math.max(rig.mouthOpen, rig.mouthOpenOverride ?? 0);

  // Mouth: segmented pixel-style bar.
  const mouthY = 27;
  const mouthSegments = 5;
  const segmentWidth = 2.4;
  const segmentGap = 0.6;
  const totalMouthWidth = mouthSegments * segmentWidth + (mouthSegments - 1) * segmentGap;
  const mouthStartX = 20 - totalMouthWidth / 2;

  // Mouth curve: smile bends segments up, frown bends down.
  const smileAmount = rig.mouthSmile * 2;

  // LED eye glow color: shifts with emotion.
  const glowColor = rig.blush > 0.3
    ? '#F4A6A0'  // blushing → pink glow
    : rig.browConcern > 0.3
    ? '#93C5FD'  // concerned → blue
    : '#F59E0B'; // default → warm amber

  // Gaze offsets.
  const pupilOffsetX = gazeX * 1.2;
  const pupilOffsetY = gazeY * 0.8;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`${motionClass} ${className}`}
      role="img"
      aria-hidden
    >
      {/* Glow filter */}
      <defs>
        <filter id="robot-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Antenna */}
      <line x1="20" y1="5" x2="20" y2="9" stroke="#B8956A" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="20" cy="4.5" r="1.5" fill={glowColor} filter="url(#robot-glow)" />

      {/* Head — rounded rectangle (warm copper) */}
      <rect
        x="6"
        y="9"
        width="28"
        height="24"
        rx="5"
        ry="5"
        fill="#D4A574"
        stroke="#B8956A"
        strokeWidth="0.8"
        style={{ transform: `rotate(${rig.headTilt * 3}deg)`, transformOrigin: '20px 21px' }}
      />
      {/* Inner face plate */}
      <rect x="9" y="12" width="22" height="18" rx="3" ry="3" fill="#DCBA8A" opacity={0.35} />

      {/* Bolts / rivets */}
      <circle cx="9" cy="13" r="1" fill="#B8956A" opacity={0.6} />
      <circle cx="31" cy="13" r="1" fill="#B8956A" opacity={0.6} />
      <circle cx="9" cy="29" r="1" fill="#B8956A" opacity={0.6} />
      <circle cx="31" cy="29" r="1" fill="#B8956A" opacity={0.6} />

      {/* Brows (mechanical — small rectangles) */}
      {(rig.browConcern > 0.08 || rig.browAsymmetry > 0.08) && (
        <>
          <rect
            x={11}
            y={13 + rig.browConcern * 0.8}
            width={5}
            height={0.8}
            rx={0.4}
            fill="#6B4E3D"
            style={{
              transform: `rotate(${rig.browConcern * 8}deg)`,
              transformOrigin: '13.5px 13.5px',
            }}
          />
          <rect
            x={24}
            y={13 + rig.browConcern * 0.8 + rig.browAsymmetry}
            width={5}
            height={0.8}
            rx={0.4}
            fill="#6B4E3D"
            style={{
              transform: `rotate(${-rig.browConcern * 8 + rig.browAsymmetry * 5}deg)`,
              transformOrigin: '26.5px 13.5px',
            }}
          />
        </>
      )}

      {/* Eyes — LED rectangles with glow */}
      <rect
        x={12 + pupilOffsetX - eyeWidth / 2}
        y={eyeY + pupilOffsetY - eyeHeight / 2}
        width={eyeWidth}
        height={eyeHeight}
        rx={1}
        fill={glowColor}
        filter="url(#robot-glow)"
      />
      <rect
        x={28 + pupilOffsetX - eyeWidth / 2}
        y={eyeY + rig.browAsymmetry * 0.6 + pupilOffsetY - eyeHeight / 2}
        width={eyeWidth}
        height={eyeHeight}
        rx={1}
        fill={glowColor}
        filter="url(#robot-glow)"
      />
      {/* Eye highlights */}
      <rect
        x={12 + pupilOffsetX * 0.6 - 0.6}
        y={eyeY + pupilOffsetY * 0.4 - eyeHeight / 2 + 0.5}
        width={1.2}
        height={1}
        rx={0.3}
        fill="white"
        opacity={0.8}
      />
      <rect
        x={28 + pupilOffsetX * 0.6 - 0.6}
        y={eyeY + rig.browAsymmetry * 0.6 + pupilOffsetY * 0.4 - eyeHeight / 2 + 0.5}
        width={1.2}
        height={1}
        rx={0.3}
        fill="white"
        opacity={0.8}
      />

      {/* Mouth — segmented pixel bar */}
      {Array.from({ length: mouthSegments }).map((_, i) => {
        const x = mouthStartX + i * (segmentWidth + segmentGap);
        // Parabolic curve: center segments shift more than edges for smile.
        const distFromCenter = Math.abs(i - (mouthSegments - 1) / 2);
        const yOffset = smileAmount * (1 - distFromCenter / ((mouthSegments - 1) / 2));
        const segH = 1.5 + effectiveMouthOpen * 2.5;

        return (
          <rect
            key={i}
            x={x}
            y={mouthY - yOffset}
            width={segmentWidth}
            height={segH}
            rx={0.5}
            fill={effectiveMouthOpen > 0.25 ? '#8B5E3C' : '#6B4E3D'}
            opacity={0.8 + effectiveMouthOpen * 0.2}
          />
        );
      })}

      {/* Blush (warm LED glow on cheeks) */}
      {rig.blush > 0.05 && (
        <>
          <circle cx={10} cy={22} r={2} fill="#F4A6A0" opacity={0.2 + rig.blush * 0.4} filter="url(#robot-glow)" />
          <circle cx={30} cy={22} r={2} fill="#F4A6A0" opacity={0.2 + rig.blush * 0.4} filter="url(#robot-glow)" />
        </>
      )}

      {/* Sweat */}
      {rig.sweat && (
        <ellipse cx={32} cy={12} rx={0.9} ry={1.3} fill="#93C5FD" opacity={0.75} className="animate-potato-sweat" />
      )}

      {/* Sparkle */}
      {rig.sparkle && (
        <g className="animate-potato-sparkle">
          <line x1={5} y1={7} x2={5} y2={11} stroke="#F59E0B" strokeWidth="0.8" strokeLinecap="round" />
          <line x1={3} y1={9} x2={7} y2={9} stroke="#F59E0B" strokeWidth="0.8" strokeLinecap="round" />
          <line x1={35} y1={8} x2={35} y2={12} stroke="#F59E0B" strokeWidth="0.8" strokeLinecap="round" />
          <line x1={33} y1={10} x2={37} y2={10} stroke="#F59E0B" strokeWidth="0.8" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
