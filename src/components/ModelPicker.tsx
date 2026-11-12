'use client';

import { useEffect, useState } from 'react';
import { useCore } from '@/components/providers/CoreProvider';
import type { CatalogModel } from '@/lib/core/types';

function describe(model: CatalogModel): string {
  const parts = [
    model.contextLength ? `${Math.round(model.contextLength / 1000)}k ctx` : null,
    model.supportsTools ? 'tools' : 'no tools',
    model.retention,
  ].filter(Boolean);
  return `${model.name}${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
}

/**
 * Minimal model picker: the catalog comes from the authenticated core (context,
 * tool support, retention), and the choice is persisted server-side so it
 * survives a restart. Only shown when a catalog is available.
 */
export function ModelPicker() {
  const { client, online } = useCore();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [active, setActive] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    (async () => {
      try {
        const catalog = await client.listModels();
        if (cancelled) return;
        setModels(catalog.models);
        if (catalog.activeModel) {
          const match = catalog.models.find(
            (model) => model.id === catalog.activeModel,
          );
          setActive(match ? `${match.provider}:${match.id}` : '');
        }
      } catch {
        // Offline or an unavailable catalog: leave the picker hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, online]);

  if (models.length === 0) return null;

  const choose = async (value: string) => {
    const [provider, ...rest] = value.split(':');
    const modelId = rest.join(':');
    setSaving(true);
    try {
      await client.setActiveModel(modelId, provider);
      setActive(value);
    } catch {
      // Keep the previous selection; the next catalog fetch will resync.
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="mr-auto flex items-center gap-1 text-xs text-[var(--muted)]">
      <span className="sr-only">Model</span>
      <select
        aria-label="Model"
        value={active}
        disabled={saving}
        onChange={(event) => void choose(event.target.value)}
        className="max-w-[14rem] truncate rounded-md border border-[var(--card-border)] bg-[var(--card)] px-2 py-1 text-xs"
      >
        {!active && <option value="">Choose a model…</option>}
        {models.map((model) => {
          const value = `${model.provider}:${model.id}`;
          return (
            <option key={value} value={value}>
              {describe(model)}
            </option>
          );
        })}
      </select>
    </label>
  );
}
