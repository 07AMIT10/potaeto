'use client';

import type { ExpressionState } from '@/lib/expressions/types';
import { getRigForExpression } from '@/lib/expressions/rig';
import { useSpringRig } from '@/lib/expressions/useSpringRig';
import type { AvatarTemplateId } from '@/lib/avatar/template';
import { PotatoRig } from '@/components/avatar/PotatoRig';
import { CatRig } from '@/components/avatar/CatRig';
import { RobotRig } from '@/components/avatar/RobotRig';

export interface AvatarFaceProps {
  template?: AvatarTemplateId;
  expression: ExpressionState;
  intensity?: number;
  size?: number;
  className?: string;
  /** Mouth-open override from talking animation (0..1). */
  mouthOpenOverride?: number;
  /** Horizontal gaze offset (-1..1). */
  gazeX?: number;
  /** Vertical gaze offset (-1..1). */
  gazeY?: number;
}

function motionForExpression(expression: ExpressionState): string {
  switch (expression) {
    case 'excited':
    case 'surprised':
      return 'animate-potato-bounce';
    case 'amused':
    case 'mischievous':
      return 'animate-potato-wiggle';
    case 'thoughtful':
    case 'sleepy':
      return 'animate-potato-tilt';
    case 'angry':
      return 'animate-potato-wiggle';
    case 'nervous':
      return 'animate-potato-wiggle';
    default:
      return '';
  }
}

export function AvatarFace({
  template = 'potato',
  expression,
  intensity = 0.5,
  size = 40,
  className = '',
  mouthOpenOverride,
  gazeX,
  gazeY,
}: AvatarFaceProps) {
  const targetRig = getRigForExpression(expression, intensity);
  const rig = useSpringRig(targetRig);
  const motion = motionForExpression(expression);

  // Apply talking-mouth override (take the larger of expression vs talking).
  if (mouthOpenOverride !== undefined && mouthOpenOverride > rig.mouthOpen) {
    rig.mouthOpen = mouthOpenOverride;
  }

  // Pass gaze through.
  rig.gazeX = gazeX ?? 0;
  rig.gazeY = gazeY ?? 0;

  if (template === 'cat') {
    return <CatRig rig={rig} size={size} className={className} motionClass={motion} />;
  }

  if (template === 'robot') {
    return <RobotRig rig={rig} size={size} className={className} motionClass={motion} />;
  }

  return <PotatoRig rig={rig} size={size} className={className} motionClass={motion} />;
}
