-- Seed baseline models for Cerebras, SambaNova, and OpenRouter.
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
    -- Cerebras (OpenAI-compatible API: https://api.cerebras.ai/v1)
    ('cerebras', 'llama3.1-8b',                 'Cerebras Llama 3.1 8B',                'summarize',         70,  true, 0.2::real,  768),
    ('cerebras', 'llama-3.3-70b',               'Cerebras Llama 3.3 70B',               'chat_primary',      95,  true, 0.8::real, 1024),
    ('cerebras', 'llama-3.3-70b',               'Cerebras Llama 3.3 70B',               'skill_text',        95,  true, 0.7::real, 1024),
    ('cerebras', 'qwen-3-32b',                  'Cerebras Qwen 3 32B',                  'proactive_message', 75,  true, 0.6::real,  768),

    -- SambaNova (OpenAI-compatible API: https://api.sambanova.ai/v1)
    ('sambanova', 'Meta-Llama-3.1-8B-Instruct', 'SambaNova Llama 3.1 8B Instruct',      'summarize',         72,  true, 0.2::real,  768),
    ('sambanova', 'Meta-Llama-3.3-70B-Instruct','SambaNova Llama 3.3 70B Instruct',     'chat_primary',      98,  true, 0.8::real, 1024),
    ('sambanova', 'Meta-Llama-3.3-70B-Instruct','SambaNova Llama 3.3 70B Instruct',     'skill_text',        98,  true, 0.7::real, 1024),
    ('sambanova', 'Meta-Llama-3.1-8B-Instruct', 'SambaNova Llama 3.1 8B Instruct',      'proactive_message', 78,  true, 0.6::real,  640),

    -- OpenRouter (Free router + direct free variant examples)
    ('openrouter', 'openrouter/free',                              'OpenRouter Free Router',                   'chat_primary',      130, true, 0.8::real, 1024),
    ('openrouter', 'openrouter/free',                              'OpenRouter Free Router',                   'skill_text',        130, true, 0.7::real, 1024),
    ('openrouter', 'meta-llama/llama-3.2-3b-instruct:free',       'OpenRouter Llama 3.2 3B Free',            'summarize',         120, true, 0.2::real,  640),
    ('openrouter', 'meta-llama/llama-3.2-3b-instruct:free',       'OpenRouter Llama 3.2 3B Free',            'proactive_message', 125, true, 0.6::real,  640)
) as v(provider, model_key, display_name, task_type, priority, enabled, temperature, max_output_tokens)
where not exists (
  select 1
  from public.models_config m
  where m.provider = v.provider
    and m.model_key = v.model_key
    and m.task_type = v.task_type
);
