'use client';

import { AvatarFace, type AvatarFaceProps } from '@/components/AvatarFace';

export type PotatoFaceProps = Omit<AvatarFaceProps, 'template'>;

/** @deprecated Prefer AvatarFace with template prop; kept for backward compatibility. */
export function PotatoFace(props: PotatoFaceProps) {
  return <AvatarFace template="potato" {...props} />;
}
