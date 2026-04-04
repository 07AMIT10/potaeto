-- Seed baseline Groq models for main text task types.
-- Safe to run multiple times; inserts only when provider+model+task_type is missing.

insert into public.models_config (
  provider,
  model_key,
  display_name,
  task_type,
  priority,
  enabled,
  temperature,
  max_output_tokens
)
select
  v.provider,
  v.model_key,
  v.display_name,
  v.task_type,
  v.priority,
  v.enabled,
  v.temperature,
  v.max_output_tokens
from (
  values
    ('groq', 'llama-3.1-8b-instant',    'Groq Llama 3.1 8B Instant',    'summarize',         80,  true, 0.2::real,  768),
    ('groq', 'llama-3.1-8b-instant',    'Groq Llama 3.1 8B Instant',    'proactive_message', 85,  true, 0.7::real,  512),
    ('groq', 'llama-3.3-70b-versatile', 'Groq Llama 3.3 70B Versatile', 'chat_primary',      110, true, 0.8::real, 1024),
    ('groq', 'llama-3.3-70b-versatile', 'Groq Llama 3.3 70B Versatile', 'skill_text',        110, true, 0.7::real, 1024)
) as v(provider, model_key, display_name, task_type, priority, enabled, temperature, max_output_tokens)
where not exists (
  select 1
  from public.models_config m
  where m.provider = v.provider
    and m.model_key = v.model_key
    and m.task_type = v.task_type
);
