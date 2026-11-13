'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { CoreClient, CoreError } from '@/lib/core/client';
import { LocalDb } from '@/lib/core/db';
import { SyncEngine } from '@/lib/core/sync';
import type { ConversationInfo, PrimaryAgent } from '@/lib/core/types';

/**
 * Resolve the core base URL baked into the client bundle.
 *
 * Production builds leave `NEXT_PUBLIC_CORE_URL` empty so requests go to
 * relative `/v1/*` paths and Caddy proxies them same-origin. Development sets
 * the variable to the core's address in `.env.local`.
 */
export function coreBaseUrl(value = process.env.NEXT_PUBLIC_CORE_URL): string {
  if (typeof window !== 'undefined') {
    const custom = localStorage.getItem('potaeto_core_url');
    if (custom) return custom.replace(/\/+$/, '');
    if (window.location.origin.includes('tauri.localhost') || window.location.origin.includes('tauri://')) {
      return 'http://127.0.0.1:8010';
    }
  }
  return value ?? '';
}

const CORE_URL = coreBaseUrl();

export interface CoreContextValue {
  client: CoreClient;
  db: LocalDb;
  sync: SyncEngine;
  /** The shared (user, primary agent) conversation, once resolved. */
  conversationId: string | null;
  agent: PrimaryAgent | null;
  online: boolean;
  /** True once the first boot attempt has completed (success or failure). */
  booted: boolean;
  /** Incremented after a successful flush+pull so consumers can reload. */
  syncVersion: number;
  /** (Re)resolve the agent/conversation and reconcile with the core. */
  boot: () => Promise<void>;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export function CoreProvider({ children }: { children: ReactNode }) {
  const { client, db, sync } = useMemo(() => {
    const client = new CoreClient({ baseUrl: CORE_URL });
    const db = new LocalDb('potaeto');
    const sync = new SyncEngine(db, client);
    return { client, db, sync };
  }, []);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [agent, setAgent] = useState<PrimaryAgent | null>(null);
  const [online, setOnline] = useState<boolean>(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  const [booted, setBooted] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);

  const boot = useCallback(async () => {
    try {
      const [agent, conversation] = await Promise.all([
        client.getPrimaryAgent(),
        client.getConversation(),
      ]);
      setAgent(agent);
      setConversationId(conversation.id);
      // Persist before reconciling so an offline reload can still render the
      // cached conversation even if flush/pull below fails.
      await db.saveAgent(agent);
      await db.saveConversationId(conversation.id);
      await sync.flush();
      await sync.pull();
      setSyncVersion((v) => v + 1);
    } catch (error) {
      // A 401/403 means this device is not paired: do not resurrect a stale
      // cache. Any other failure (offline, core unreachable) hydrates the
      // cached agent + conversation so offline reloads keep their history and
      // can queue messages for the next flush.
      if (!(error instanceof CoreError && (error.status === 401 || error.status === 403))) {
        const [cachedAgent, cachedConversationId] = await Promise.all([
          db.getAgent(),
          db.getConversationId(),
        ]);
        if (cachedAgent) setAgent(cachedAgent);
        if (cachedConversationId) setConversationId(cachedConversationId);
      }
    } finally {
      setBooted(true);
    }
  }, [client, db, sync]);

  useEffect(() => {
    void boot();
    const onOnline = () => {
      setOnline(true);
      void boot();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [boot]);

  const value = useMemo<CoreContextValue>(
    () => ({ client, db, sync, conversationId, agent, online, booted, syncVersion, boot }),
    [client, db, sync, conversationId, agent, online, booted, syncVersion, boot],
  );

  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

export function useCore(): CoreContextValue {
  const ctx = useContext(CoreContext);
  if (!ctx) {
    throw new Error('useCore must be used within a CoreProvider');
  }
  return ctx;
}
