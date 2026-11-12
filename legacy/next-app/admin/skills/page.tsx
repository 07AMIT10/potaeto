import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminSkillsPage() {
  const supabase = createServiceClient();

  const { data: skills } = await supabase
    .from('skills')
    .select('id, name, description, category, pipeline_config');

  const { data: entitySkills } = await supabase
    .from('entity_skills')
    .select('entity_id, skill_id, enabled');

  const bySkill = new Map<string, { total: number; enabled: number }>();
  for (const row of entitySkills ?? []) {
    const current = bySkill.get(row.skill_id) ?? { total: 0, enabled: 0 };
    bySkill.set(row.skill_id, {
      total: current.total + 1,
      enabled: current.enabled + (row.enabled ? 1 : 0),
    });
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="page-title">Skills</h2>
        <p className="text-sm text-[var(--muted)] mt-1">Skills catalog and entity usage.</p>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">ID</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Name</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Category</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Pipeline</th>
                <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Entities</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Description</th>
              </tr>
            </thead>
            <tbody>
              {(skills ?? []).map((s) => {
                const counts = bySkill.get(s.id) ?? { total: 0, enabled: 0 };
                const hasPipeline = s.pipeline_config && typeof s.pipeline_config === 'object' &&
                  (s.pipeline_config as Record<string, unknown>).steps;
                return (
                  <tr key={s.id} className="border-b border-[var(--card-border)] last:border-0">
                    <td className="px-4 py-3 font-mono text-[11px] whitespace-nowrap">{s.id}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-medium">{s.name}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{s.category ?? '\u2014'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        hasPipeline
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                      }`}>
                        {hasPipeline ? 'configured' : 'legacy'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">{counts.enabled} / {counts.total}</td>
                    <td className="px-4 py-3 text-[var(--muted)] max-w-xs">{s.description}</td>
                  </tr>
                );
              })}
              {(!skills || skills.length === 0) && (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--muted)]" colSpan={6}>
                    No skills configured. Seed the skills table.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-[var(--muted)]">
        Manage skills via SQL or Supabase dashboard. Pipeline config drives the SkillsService in the orchestrator.
      </p>
    </div>
  );
}
