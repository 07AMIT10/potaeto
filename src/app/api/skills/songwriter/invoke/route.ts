import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:8000';

type SongwriterInvokeBody = {
  entityId: string;
  prompt: string;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as Partial<SongwriterInvokeBody>;
  const entityId = body.entityId;
  const prompt = body.prompt;

  if (!entityId || !prompt) {
    return NextResponse.json({ error: 'Missing entityId or prompt' }, { status: 400 });
  }

  const { data: entity, error: entityError } = await supabase
    .from('entities')
    .select('id, user_id, name, persona')
    .eq('id', entityId)
    .eq('user_id', user.id)
    .single();

  if (entityError || !entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/v1/skills/songwriter/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        entity_name: entity.name,
        persona: entity.persona ?? null,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('songwriter orchestrator error:', res.status, text);
      return NextResponse.json({ error: 'Skill invocation failed' }, { status: 502 });
    }

    const data = (await res.json()) as { output?: string };
    const output = (data.output ?? '').trim();

    if (!output) {
      return NextResponse.json({ error: 'Empty skill output' }, { status: 502 });
    }

    const { error: insertError } = await supabase.from('skill_outputs').insert({
      user_id: user.id,
      entity_id: entityId,
      skill_id: 'songwriter',
      content_type: 'text',
      text_content: output,
      metadata: {
        prompt,
      },
    });

    if (insertError) {
      console.error('skill_outputs insert error:', insertError);
    }

    return NextResponse.json({ content: output });
  } catch (err) {
    console.error('songwriter invoke error:', err);
    return NextResponse.json({ error: 'Skill invocation failed' }, { status: 500 });
  }
}

