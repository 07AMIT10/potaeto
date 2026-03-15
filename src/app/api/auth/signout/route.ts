import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { clearSession } from '@/lib/auth/appAuth';

export async function POST(request: Request) {
  await clearSession();
  const supabase = await createClient();
  await supabase.auth.signOut();
  const url = new URL(request.url);
  return NextResponse.redirect(new URL('/login', url.origin));
}
