import { NextResponse } from 'next/server';
import { createAdminSession, validateAdminCredentials } from '@/lib/auth/adminAuth';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';

  if (!validateAdminCredentials(username, password)) {
    return NextResponse.json({ error: 'Invalid admin credentials.' }, { status: 401 });
  }

  await createAdminSession(username);
  return NextResponse.json({ ok: true });
}
