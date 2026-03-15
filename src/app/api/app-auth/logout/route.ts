import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/auth/appAuth';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  await clearSession();

  // Also sign out of Supabase auth if present, but ignore errors.
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } catch {
    // ignore
  }

  const url = new URL(request.url);
  return NextResponse.redirect(new URL('/login', url.origin));
}

