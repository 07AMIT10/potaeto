import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentAuthContext } from '@/lib/auth/appAuth';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const ctx = await getCurrentAuthContext(async () => user?.id ?? null);

  return NextResponse.json(ctx);
}

