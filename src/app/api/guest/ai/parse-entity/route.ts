import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL } from '@/lib/config';

export async function POST(request: Request) {
  const body = await request.json();
  const { text } = body as { text?: string };

  if (!text || typeof text !== 'string') {
    return NextResponse.json({ error: 'Missing or invalid text' }, { status: 400 });
  }

  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/v1/parse-entity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      console.error('guest orchestrator parse-entity error:', res.status, msg);
      return NextResponse.json({ error: 'Failed to parse entity' }, { status: 502 });
    }

    const entity = (await res.json()) as {
      name: string;
      slug: string;
      characteristics?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      persona?: Record<string, unknown>;
      skills?: string[];
      attributes?: Record<string, unknown>;
    };

    if (!entity.name || !entity.slug) {
      return NextResponse.json({ error: 'Invalid entity structure from orchestrator' }, { status: 500 });
    }

    return NextResponse.json(entity);
  } catch (err) {
    console.error('guest parse-entity error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to parse entity' },
      { status: 500 }
    );
  }
}

