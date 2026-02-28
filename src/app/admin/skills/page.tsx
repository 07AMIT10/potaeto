import { headers } from 'next/headers';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminSkillsPage() {
  const headersList = await headers();
  const provided = headersList.get('x-admin-secret');
  const expected = process.env.ADMIN_SECRET;
  if (expected && provided !== expected) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <p className="text-gray-500">Unauthorized. Set X-Admin-Secret header to ADMIN_SECRET.</p>
      </main>
    );
  }

  const supabase = createServiceClient();

  const { data: skills } = await supabase
    .from('skills')
    .select('id, name, description, category');

  const { data: entitySkills } = await supabase
    .from('entity_skills')
    .select('entity_id, skill_id, enabled');

  const bySkill = new Map<
    string,
    { total: number; enabled: number }
  >();

  for (const row of entitySkills ?? []) {
    const current = bySkill.get(row.skill_id) ?? { total: 0, enabled: 0 };
    bySkill.set(row.skill_id, {
      total: current.total + 1,
      enabled: current.enabled + (row.enabled ? 1 : 0),
    });
  }

  return (
    <main className="min-h-screen max-w-4xl mx-auto px-4 py-8 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-potato-800 mb-1">Admin – Skills</h1>
          <p className="text-sm text-gray-500">
            Inspect configured skills and how many entities have them enabled.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-potato-600 hover:underline">
          ← Back to overview
        </Link>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Skills catalog</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">ID</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Name</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Category</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Entities (enabled / total)</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Description</th>
              </tr>
            </thead>
            <tbody>
              {(skills ?? []).map((s) => {
                const counts = bySkill.get(s.id) ?? { total: 0, enabled: 0 };
                return (
                  <tr key={s.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                      {s.id}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{s.name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {s.category ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {counts.enabled} / {counts.total}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-xs">
                      {s.description}
                    </td>
                  </tr>
                );
              })}
              {(!skills || skills.length === 0) && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-xs text-gray-500"
                    colSpan={5}
                  >
                    No skills configured yet. Seed the skills table to enable the skills system.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500">
          Editing mappings is currently done via SQL / Supabase dashboard. A richer editor can be layered on later.
        </p>
      </section>
    </main>
  );
}

