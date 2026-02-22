'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Entity } from '@/types/database';

interface CreateFormProps {
  entity: Entity | null;
  entitiesList: { id: string; name: string; slug: string }[];
}

export function CreateForm({ entity, entitiesList }: CreateFormProps) {
  const router = useRouter();
  const [name, setName] = useState(entity?.name ?? '');
  const [slug, setSlug] = useState(entity?.slug ?? '');
  const [characteristics, setCharacteristics] = useState(
    JSON.stringify((entity?.characteristics as object) ?? {}, null, 2)
  );
  const [appearance, setAppearance] = useState(
    JSON.stringify((entity?.appearance as object) ?? {}, null, 2)
  );
  const [persona, setPersona] = useState(
    JSON.stringify((entity?.persona as object) ?? {}, null, 2)
  );
  const [skills, setSkills] = useState(
    Array.isArray(entity?.skills) ? (entity.skills as string[]).join(', ') : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entity) {
      setName(entity.name);
      setSlug(entity.slug);
      setCharacteristics(JSON.stringify((entity.characteristics as object) ?? {}, null, 2));
      setAppearance(JSON.stringify((entity.appearance as object) ?? {}, null, 2));
      setPersona(JSON.stringify((entity.persona as object) ?? {}, null, 2));
      setSkills(Array.isArray(entity.skills) ? (entity.skills as string[]).join(', ') : '');
    }
  }, [entity]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    let charJson: object, appearJson: object, personaJson: object;
    try {
      charJson = JSON.parse(characteristics || '{}');
      appearJson = JSON.parse(appearance || '{}');
      personaJson = JSON.parse(persona || '{}');
    } catch {
      setError('Invalid JSON in characteristics, appearance, or persona');
      setSaving(false);
      return;
    }
    const skillsArr = skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await fetch(entity ? `/api/entities/${entity.id}` : '/api/entities', {
      method: entity ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name || 'Unnamed',
        slug: slug || 'entity',
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
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Slug (for share URL)</label>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="my-character"
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Characteristics (JSON)</label>
        <textarea
          value={characteristics}
          onChange={(e) => setCharacteristics(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 font-mono text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Appearance (JSON)</label>
        <textarea
          value={appearance}
          onChange={(e) => setAppearance(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 font-mono text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Persona (JSON)</label>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 font-mono text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Skills (comma-separated)</label>
        <input
          type="text"
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
          placeholder="cooking, storytelling"
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-potato-500 px-6 py-2.5 font-medium text-white hover:bg-potato-600 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {entity && (
          <Link
            href={`/chat/${entity.id}`}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-6 py-2.5 font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Chat with {entity.name}
          </Link>
        )}
      </div>
      {entitiesList.length > 0 && (
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Your entities</p>
          <ul className="mt-2 space-y-1">
            {entitiesList.map((e) => (
              <li key={e.id}>
                <Link href={`/chat/${e.id}`} className="text-potato-600 hover:underline">
                  {e.name} ({e.slug})
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
