import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL } from '@/lib/config';
import { isAdminRequestAuthorized } from '@/lib/auth/adminAuth';

/**
 * GET /api/admin/health
 * Proxies the orchestrator /v1/health endpoint. Protected by ADMIN_SECRET.
 */
export async function GET(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/v1/health`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Orchestrator unreachable', status: res.status },
        { status: 502 }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'Orchestrator offline', detail: err instanceof Error ? err.message : String(err) },
      { status: 503 }
    );
  }
}
