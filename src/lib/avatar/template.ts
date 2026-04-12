export const AVATAR_TEMPLATES = ['potato', 'cat', 'robot'] as const;
export type AvatarTemplateId = (typeof AVATAR_TEMPLATES)[number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads `attributes.avatar_template` from an entity row. Unknown values fall back to potato. */
export function parseAvatarTemplate(attributes: unknown): AvatarTemplateId {
  if (!isRecord(attributes)) return 'potato';
  const t = attributes.avatar_template;
  if (t === 'cat') return 'cat';
  if (t === 'robot') return 'robot';
  return 'potato';
}
