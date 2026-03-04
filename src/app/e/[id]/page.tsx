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

  const renderJsonSection = (title: string, data: Record<string, unknown>) => {
    if (Object.keys(data).length === 0) return null;
    return (
      <div>
        <h2 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide mb-2">{title}</h2>
        <div className="rounded-xl bg-black/5 dark:bg-white/5 p-3">
          <pre className="text-sm leading-relaxed whitespace-pre-wrap">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-8">
      <div className="card p-6 sm:p-8 space-y-6 animate-fade-in">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-potato-100 dark:bg-potato-900/30 flex items-center justify-center text-2xl font-bold">
            {entity.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold">{entity.name}</h1>
            <p className="text-sm text-[var(--muted)]">A character on Potaeto</p>
          </div>
        </div>

        {renderJsonSection('Characteristics', characteristics)}
        {renderJsonSection('Appearance', appearance)}
        {renderJsonSection('Persona', persona)}

        {Array.isArray(entity.skills) && (entity.skills as string[]).length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide mb-2">Skills</h2>
            <div className="flex flex-wrap gap-2">
              {(entity.skills as string[]).map((skill) => (
                <span key={skill} className="inline-flex rounded-full bg-potato-100 dark:bg-potato-900/30 px-3 py-1 text-xs font-medium text-potato-700 dark:text-potato-300">
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="pt-4 border-t border-[var(--card-border)]">
          <Link href="/login" className="btn-primary inline-flex">
            Sign in to chat with {entity.name}
          </Link>
        </div>
      </div>
    </main>
  );
}
