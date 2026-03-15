import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';

const SESSION_COOKIE = 'app_session';
const SESSION_TTL_HOURS = 30 * 24; // 30 days

export type AppUser = {
  id: string;
  email: string;
};

export type AuthMode = 'guest' | 'app' | 'supabase';

export type AuthContext = {
  mode: AuthMode;
  appUser: AppUser | null;
  supabaseUserId: string | null;
};

async function getSessionTokenFromCookie() {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

function getExpiryDate() {
  const expires = new Date();
  expires.setHours(expires.getHours() + SESSION_TTL_HOURS);
  return expires;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex');
  const supabase = createServiceClient();
  const expiresAt = getExpiryDate().toISOString();

  await supabase.from('app_sessions').insert({
    token,
    user_id: userId,
    expires_at: expiresAt,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: getExpiryDate(),
  });
}

export async function clearSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const supabase = createServiceClient();
    await supabase.from('app_sessions').delete().eq('token', token);
  }
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export async function getCurrentAppUser(): Promise<AppUser | null> {
  const token = await getSessionTokenFromCookie();
  if (!token) return null;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('app_sessions')
    .select('user:app_users(id,email), expires_at')
    .eq('token', token)
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.user) return null;

  const expiresAt = new Date(data.expires_at);
  if (expiresAt.getTime() < Date.now()) {
    await clearSession();
    return null;
  }

  return {
    id: data.user.id,
    email: data.user.email,
  };
}

export async function getCurrentAuthContext(getSupabaseUserId: () => Promise<string | null>): Promise<AuthContext> {
  const appUser = await getCurrentAppUser();
  if (appUser) {
    return { mode: 'app', appUser, supabaseUserId: null };
  }

  const supabaseUserId = await getSupabaseUserId();
  if (supabaseUserId) {
    return { mode: 'supabase', appUser: null, supabaseUserId };
  }

  return { mode: 'guest', appUser: null, supabaseUserId: null };
}


