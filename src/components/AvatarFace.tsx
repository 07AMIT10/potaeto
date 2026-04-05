'use client';

import type { ExpressionState } from '@/lib/expressions/types';
import { getRigForExpression } from '@/lib/expressions/rig';
import type { AvatarTemplateId } from '@/lib/avatar/template';
import { PotatoRig } from '@/components/avatar/PotatoRig';
import { CatRig } from '@/components/avatar/CatRig';

export interface AvatarFaceProps {
  template?: AvatarTemplateId;
  expression: ExpressionState;
  intensity?: number;
  size?: number;
  className?: string;
}

function motionForExpression(expression: ExpressionState): string {
  if (expression === 'excited') return 'animate-potato-bounce';
  if (expression === 'amused') return 'animate-potato-wiggle';
  if (expression === 'thoughtful') return 'animate-potato-tilt';
  return '';
}

export function AvatarFace({
  template = 'potato',
  expression,
  intensity = 0.5,
  size = 40,
  className = '',
}: AvatarFaceProps) {
  const rig = getRigForExpression(expression, intensity);
  const motion = motionForExpression(expression);

  if (template === 'cat') {
    return <CatRig rig={rig} size={size} className={className} motionClass={motion} />;
  }

  return <PotatoRig rig={rig} size={size} className={className} motionClass={motion} />;
}
