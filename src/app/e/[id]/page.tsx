import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';

export default async function EntityProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: entity } = await supabase
    .from('entities')
    .select('id, name, slug, characteristics, appearance, persona, skills, is_public')
    .eq('id', id)
    .eq('is_public', true)
    .single();

  if (!entity) notFound();

  const characteristics = (entity.characteristics as Record<string, unknown>) ?? {};
  const appearance = (entity.appearance as Record<string, unknown>) ?? {};
  const persona = (entity.persona as Record<string, unknown>) ?? {};

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-8">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 p-6 space-y-4">
        <h1 className="text-2xl font-bold text-potato-800">{entity.name}</h1>
        <p className="text-sm text-gray-500">A WHO/WHAT on Potaeto</p>
        {Object.keys(characteristics).length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Characteristics</h2>
            <pre className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap mt-1">
              {JSON.stringify(characteristics, null, 2)}
            </pre>
          </div>
        )}
        {Object.keys(appearance).length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Appearance</h2>
            <pre className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap mt-1">
              {JSON.stringify(appearance, null, 2)}
            </pre>
          </div>
        )}
        {Object.keys(persona).length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Persona</h2>
            <pre className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap mt-1">
              {JSON.stringify(persona, null, 2)}
            </pre>
          </div>
        )}
        <div className="pt-4">
          <Link
            href="/login"
            className="text-potato-600 hover:underline font-medium"
          >
            Sign in to chat with {entity.name} or create your own
          </Link>
        </div>
      </div>
    </main>
  );
}
