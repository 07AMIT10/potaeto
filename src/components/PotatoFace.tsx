'use client';

import type { ExpressionState } from '@/lib/expressions/types';

interface PotatoFaceProps {
  expression: ExpressionState;
  intensity?: number;
  size?: number;
  className?: string;
}

interface FaceConfig {
  leftEye: { cx: number; cy: number; rx: number; ry: number };
  rightEye: { cx: number; cy: number; rx: number; ry: number };
  mouth: string;
  leftBrow?: string;
  rightBrow?: string;
  blush?: boolean;
  sweat?: boolean;
  sparkle?: boolean;
}

const FACE_CONFIGS: Record<ExpressionState, FaceConfig> = {
  idle: {
    leftEye: { cx: 14, cy: 16, rx: 1.8, ry: 2 },
    rightEye: { cx: 26, cy: 16, rx: 1.8, ry: 2 },
    mouth: 'M 15 24 Q 20 27 25 24',
  },
  happy: {
    leftEye: { cx: 14, cy: 16, rx: 1.8, ry: 1.2 },
    rightEye: { cx: 26, cy: 16, rx: 1.8, ry: 1.2 },
    mouth: 'M 13 23 Q 20 29 27 23',
    blush: true,
  },
  amused: {
    leftEye: { cx: 14, cy: 16, rx: 2, ry: 0.8 },
    rightEye: { cx: 26, cy: 16, rx: 2, ry: 0.8 },
    mouth: 'M 14 23 Q 20 30 26 23 L 26 23 Q 20 26 14 23',
  },
  thoughtful: {
    leftEye: { cx: 14, cy: 16, rx: 1.5, ry: 2 },
    rightEye: { cx: 26, cy: 15.5, rx: 2, ry: 2.2 },
    mouth: 'M 16 25 Q 20 25.5 24 25',
    leftBrow: 'M 11 12.5 Q 14 11 17 12',
    rightBrow: 'M 23 11.5 Q 26 10 29 12',
  },
  concerned: {
    leftEye: { cx: 14, cy: 16, rx: 1.8, ry: 2.2 },
    rightEye: { cx: 26, cy: 16, rx: 1.8, ry: 2.2 },
    mouth: 'M 15 26 Q 20 23 25 26',
    leftBrow: 'M 11 12 Q 14 13.5 17 12.5',
    rightBrow: 'M 23 12.5 Q 26 13.5 29 12',
    sweat: true,
  },
  sad: {
    leftEye: { cx: 14, cy: 17, rx: 1.6, ry: 1.5 },
    rightEye: { cx: 26, cy: 17, rx: 1.6, ry: 1.5 },
    mouth: 'M 15 27 Q 20 23 25 27',
    leftBrow: 'M 11 13 Q 14 14.5 17 14',
    rightBrow: 'M 23 14 Q 26 14.5 29 13',
  },
  excited: {
    leftEye: { cx: 14, cy: 15.5, rx: 2.2, ry: 2.5 },
    rightEye: { cx: 26, cy: 15.5, rx: 2.2, ry: 2.5 },
    mouth: 'M 13 22 Q 20 30 27 22 L 27 22 Q 20 25 13 22',
    sparkle: true,
  },
  confused: {
    leftEye: { cx: 14, cy: 16, rx: 1.8, ry: 2 },
    rightEye: { cx: 26, cy: 15, rx: 2, ry: 2.5 },
    mouth: 'M 15 25 Q 18 24 20 26 Q 22 24 25 25',
    leftBrow: 'M 11 12.5 Q 14 12 17 13',
    rightBrow: 'M 23 11 Q 26 10 29 12.5',
  },
};

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

export function PotatoFace({ expression, intensity = 0.5, size = 40, className = '' }: PotatoFaceProps) {
  const config = FACE_CONFIGS[expression];
  const scale = size / 40;
  const bobClass = expression === 'excited' ? 'animate-potato-bounce' :
                   expression === 'amused' ? 'animate-potato-wiggle' :
                   expression === 'thoughtful' ? 'animate-potato-tilt' : '';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`transition-all duration-300 ease-in-out ${bobClass} ${className}`}
      aria-label={`${expression} expression`}
      role="img"
    >
      {/* Potato body */}
      <ellipse
        cx="20" cy="21" rx="15" ry="14"
        fill="#D4A574"
        stroke="#B8956A"
        strokeWidth="0.8"
        className="transition-all duration-300"
      />
      {/* Potato surface texture */}
      <ellipse cx="20" cy="21" rx="13" ry="12" fill="#DCBA8A" opacity={0.3} />

      {/* Eyebrows */}
      {config.leftBrow && (
        <path
          d={config.leftBrow}
          fill="none"
          stroke="#6B4E3D"
          strokeWidth="1.2"
          strokeLinecap="round"
          className="transition-all duration-300"
        />
      )}
      {config.rightBrow && (
        <path
          d={config.rightBrow}
          fill="none"
          stroke="#6B4E3D"
          strokeWidth="1.2"
          strokeLinecap="round"
          className="transition-all duration-300"
        />
      )}

      {/* Eyes */}
      <ellipse
        cx={config.leftEye.cx} cy={config.leftEye.cy}
        rx={config.leftEye.rx} ry={config.leftEye.ry}
        fill="#3D2B1F"
        className="transition-all duration-300"
      />
      <ellipse
        cx={config.rightEye.cx} cy={config.rightEye.cy}
        rx={config.rightEye.rx} ry={config.rightEye.ry}
        fill="#3D2B1F"
        className="transition-all duration-300"
      />

      {/* Eye highlights */}
      <circle cx={config.leftEye.cx + 0.5} cy={config.leftEye.cy - 0.5} r={0.6} fill="white" opacity={0.7} className="transition-all duration-300" />
      <circle cx={config.rightEye.cx + 0.5} cy={config.rightEye.cy - 0.5} r={0.6} fill="white" opacity={0.7} className="transition-all duration-300" />

      {/* Mouth */}
      <path
        d={config.mouth}
        fill={expression === 'amused' || expression === 'excited' ? '#8B5E3C' : 'none'}
        stroke="#6B4E3D"
        strokeWidth="1.2"
        strokeLinecap="round"
        className="transition-all duration-300"
      />

      {/* Blush marks */}
      {config.blush && (
        <>
          <ellipse cx={10} cy={20} rx={2.5} ry={1.2} fill="#F4A6A0" opacity={0.4 * intensity + 0.2} className="transition-opacity duration-500" />
          <ellipse cx={30} cy={20} rx={2.5} ry={1.2} fill="#F4A6A0" opacity={0.4 * intensity + 0.2} className="transition-opacity duration-500" />
        </>
      )}

      {/* Sweat drop */}
      {config.sweat && <SweatDrop x={31} y={13} />}

      {/* Sparkles */}
      {config.sparkle && (
        <>
          <Sparkle x={6} y={8} />
          <Sparkle x={34} y={10} />
        </>
      )}
    </svg>
  );
}
