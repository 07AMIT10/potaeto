import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { createServiceClient } from '@/lib/supabase/server';
import { createSession } from '@/lib/auth/appAuth';

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string };

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: user, error } = await supabase
    .from('app_users')
    .select('id, email, password_hash')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (error || !user) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
  }

  const ok = await bcrypt.compare(password, user.password_hash as string);
  if (!ok) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
  }

  await createSession(user.id);

  return NextResponse.json({ user: { id: user.id, email: user.email } });
}

