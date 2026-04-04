'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Entity } from '@/types/database';
import { useAuthMode } from '@/lib/auth/useAuthMode';
import { addGuestEntity } from '@/lib/guestStorage';

interface CreateFormProps {
  entity: Entity | null;
  entitiesList: { id: string; name: string; slug: string }[];
  seed?: string | null;
}

function stringifyFieldForInput(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as { description?: unknown };
  if (typeof record.description === 'string') {
    return record.description;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

export function CreateForm({ entity, entitiesList, seed }: CreateFormProps) {
  const router = useRouter();
  const [name, setName] = useState(entity?.name ?? '');
  const [slug, setSlug] = useState(entity?.slug ?? '');
  const [characteristics, setCharacteristics] = useState(stringifyFieldForInput(entity?.characteristics));
  const [appearance, setAppearance] = useState(stringifyFieldForInput(entity?.appearance));
  const [persona, setPersona] = useState(stringifyFieldForInput(entity?.persona));
  const [skills, setSkills] = useState(
    Array.isArray(entity?.skills) ? (entity.skills as string[]).join(', ') : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const auth = useAuthMode();

  useEffect(() => {
    if (entity) {
      setName(entity.name);
      setSlug(entity.slug);
      setCharacteristics(stringifyFieldForInput(entity.characteristics));
      setAppearance(stringifyFieldForInput(entity.appearance));
      setPersona(stringifyFieldForInput(entity.persona));
      setSkills(Array.isArray(entity.skills) ? (entity.skills as string[]).join(', ') : '');
    }
  }, [entity]);

  useEffect(() => {
    if (!entity && seed) {
      try {
        const parsed = JSON.parse(seed) as {
          name?: string;
          slug?: string;
          characteristics?: object;
          appearance?: object;
          persona?: object;
          skills?: string[];
        };
        if (parsed.name) setName(parsed.name);
        if (parsed.slug) setSlug(parsed.slug);
        if (parsed.characteristics) setCharacteristics(stringifyFieldForInput(parsed.characteristics));
        if (parsed.appearance) setAppearance(stringifyFieldForInput(parsed.appearance));
        if (parsed.persona) setPersona(stringifyFieldForInput(parsed.persona));
        if (parsed.skills && Array.isArray(parsed.skills)) {
          setSkills(parsed.skills.join(', '));
        }
      } catch {
        // ignore invalid seed
      }
    }
  }, [entity, seed]);

  /**
   * Accept plain language, JSON object, or JSON primitive.
   * Plain language becomes { description: "..." }.
   */
  const parseFlexibleField = (raw: string): object => {
    const s = (raw || '').trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'object' && parsed !== null ? parsed : { description: String(parsed) };
    } catch {
      return { description: s };
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const charJson = parseFlexibleField(characteristics);
    const appearJson = parseFlexibleField(appearance);
    const personaJson = parseFlexibleField(persona);
    const cleanName = name.trim();
    const cleanSlug = slug.trim();
    const skillsArr = skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Logged-in path: save via API
    if (auth.mode === 'app' || auth.mode === 'supabase') {
      const res = await fetch(entity ? `/api/entities/${entity.id}` : '/api/entities', {
        method: entity ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanName || 'Unnamed',
          slug: cleanSlug || undefined,
          characteristics: charJson,
          appearance: appearJson,
          persona: personaJson,
          skills: skillsArr,
        }),
      });
      const data = await res.json();
      setSaving(false);
      if (!res.ok) {
        setError(data.error ?? 'Failed to save');
        return;
      }
      router.push(`/chat/${data.id ?? entity!.id}`);
      return;
    }

    // Guest path: store locally
    const saved = addGuestEntity({
      id: entity?.id,
      name: cleanName || 'Unnamed',
      slug: cleanSlug || 'entity',
    });
    setSaving(false);
    router.push(`/chat/${saved.id}`);
  };

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="card p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
              placeholder="Chef Mario"
            />
          </div>
          <div>
            <label className="label">Slug (for share URL)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="Optional. We can auto-generate it."
              className="input-field"
            />
          </div>
        </div>

        <div>
          <label className="label">Characteristics</label>
          <textarea
            value={characteristics}
            onChange={(e) => setCharacteristics(e.target.value)}
            rows={3}
            className="input-field"
            placeholder="Friendly chef who explains each step while cooking."
          />
        </div>
        <div>
          <label className="label">Appearance</label>
          <textarea
            value={appearance}
            onChange={(e) => setAppearance(e.target.value)}
            rows={3}
            className="input-field"
            placeholder="Tall, warm smile, wears a red apron."
          />
        </div>
        <div>
          <label className="label">Persona</label>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={3}
            className="input-field"
            placeholder="Encouraging, humorous, and patient with beginners."
          />
        </div>
        <div>
          <label className="label">Skills (comma-separated)</label>
          <input
            type="text"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            placeholder="cooking, storytelling"
            className="input-field"
          />
        </div>
      </div>

      {error && (
        <div className="card border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300 animate-fade-in">
          {error}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Saving...' : 'Save'}
        </button>
        {entity && (
          <Link href={`/chat/${entity.id}`} className="btn-secondary text-center">
            Chat with {entity.name}
          </Link>
        )}
      </div>

      {entitiesList.length > 0 && (
        <div className="card p-5 mt-6">
          <h3 className="text-sm font-semibold mb-3">Your characters</h3>
          <div className="space-y-2">
            {entitiesList.map((e) => (
              <Link
                key={e.id}
                href={`/chat/${e.id}`}
                className="flex items-center justify-between rounded-xl p-3 hover:bg-potato-50 dark:hover:bg-potato-900/20 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-potato-100 dark:bg-potato-900/30 flex items-center justify-center text-sm">
                    {e.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <span className="text-sm font-medium">{e.name}</span>
                    <span className="text-xs text-[var(--muted)] ml-2">{e.slug}</span>
                  </div>
                </div>
                <svg className="w-4 h-4 text-[var(--muted)] group-hover:text-potato-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
