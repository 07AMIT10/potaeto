import { NextResponse } from 'next/server';
import { SKILL_OUTPUTS_DEFAULT_LIMIT, SKILL_OUTPUTS_MAX_LIMIT } from '@/lib/config';
import { resolveUserId } from '@/lib/auth/resolveUserId';

/**
 * GET /api/entities/[entityId]/skill-outputs
 * Returns recent skill_outputs for this entity (user must own the entity).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ entityId: string }> }
) {
  const { entityId } = await context.params;
  const { userId, supabase } = await resolveUserId();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit')) || SKILL_OUTPUTS_DEFAULT_LIMIT, SKILL_OUTPUTS_MAX_LIMIT);

  const { data: entity } = await supabase
    .from('entities')
    .select('id')
    .eq('id', entityId)
    .eq('user_id', userId)
    .single();

  if (!entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  const { data: outputs, error } = await supabase
    .from('skill_outputs')
    .select('id, skill_id, content_type, text_content, public_url, metadata, created_at')
    .eq('user_id', userId)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('skill-outputs fetch error:', error);
    return NextResponse.json({ error: 'Failed to load outputs' }, { status: 500 });
  }

  return NextResponse.json({ outputs: outputs ?? [] });
}
