import { NextResponse } from 'next/server';
import { clearAdminSession } from '@/lib/auth/adminAuth';

export async function POST() {
  await clearAdminSession();
  return NextResponse.json({ ok: true });
}
