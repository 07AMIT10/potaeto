'use client';

import { useEffect, useState } from 'react';
import type { AuthContext, AuthMode } from './appAuth';

type ClientAuthContext = AuthContext;

export function useAuthMode(): ClientAuthContext {
  const [ctx, setCtx] = useState<ClientAuthContext>({
    mode: 'guest',
    appUser: null,
    supabaseUserId: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/app-auth/me', { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as ClientAuthContext;
        if (!cancelled) setCtx(data);
      } catch {
        // ignore, stay in guest mode
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return ctx;
}

