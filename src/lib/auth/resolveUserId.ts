/**
 * Shared helper: resolve the current user ID from either auth system.
 * Checks custom app auth (app_users + app_sessions) first, then falls back to Supabase Auth.
 *
 * For app-auth users there is no Supabase auth session, so we return
 * a service-role client that bypasses RLS. For Supabase-auth users the
 * normal SSR client (which carries the user's session) is returned.
 */

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { getCurrentAppUser } from './appAuth';

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export async function resolveUserId(): Promise<{ userId: string | null; supabase: SupabaseClient }> {
  // 1. Check custom app auth first (cookie-based session)
  const appUser = await getCurrentAppUser();
  if (appUser) {
    // App-auth users have no Supabase session → use service-role client to bypass RLS
    const supabase = createServiceClient() as unknown as SupabaseClient;
    return { userId: appUser.id, supabase };
  }

  // 2. Fall back to Supabase Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { userId: user?.id ?? null, supabase };
}
