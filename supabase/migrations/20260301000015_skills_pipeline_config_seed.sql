-- Seed songwriter skill with pipeline_config so SkillsService runs the pipeline.
-- Safe to run multiple times (upsert by id).

insert into public.skills (id, name, description, icon, category, pipeline_config, updated_at)
values (
  'songwriter',
  'Songwriter',
  'Generate lyrics for a song based on mood, genre, and topic.',
  null,
  'creative',
  '{
    "steps": [
      { "id": "step1", "type": "llm", "task_type": "skill_text", "prompt_template_id": "songwriter_v1" },
      { "id": "step2", "type": "postprocess", "kind": "trim" }
    ],
    "inputs": ["prompt", "entity_name", "persona"],
    "outputs": ["lyrics"]
  }'::jsonb,
  now()
)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  pipeline_config = excluded.pipeline_config,
  updated_at = excluded.updated_at;
