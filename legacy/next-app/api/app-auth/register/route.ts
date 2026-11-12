import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { createServiceClient } from '@/lib/supabase/server';
import { createSession } from '@/lib/auth/appAuth';

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string };

  if (!email || !password || password.length < 6) {
    return NextResponse.json({ error: 'Email and password (min 6 chars) are required.' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('app_users')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'An account with this email already exists.' }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('app_users')
    .insert({
      email: email.toLowerCase(),
      password_hash: passwordHash,
    })
    .select('id, email')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Failed to create account.' }, { status: 500 });
  }

  await createSession(data.id);

  return NextResponse.json({ user: { id: data.id, email: data.email } });
}

