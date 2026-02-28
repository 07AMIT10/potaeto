-- Configuration for models used by the orchestrator/router
create table if not exists public.models_config (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_key text not null,
  display_name text,
  task_type text not null,
  priority integer not null default 100,
  enabled boolean not null default true,
  temperature real,
  top_p real,
  max_output_tokens integer,
  cost_input_per_1k numeric,
  cost_output_per_1k numeric,
  rate_limit_rpm integer,
  "group" text,
  extra jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.models_config enable row level security;

create policy "Admin only models_config"
  on public.models_config for all
  using (
    exists (
      select 1
      from public.admin_emails ae
      where ae.email = (auth.jwt() ->> 'email')
    )
  )
  with check (
    exists (
      select 1
      from public.admin_emails ae
      where ae.email = (auth.jwt() ->> 'email')
    )
  );

create index if not exists models_config_task_type on public.models_config (task_type);
create index if not exists models_config_provider on public.models_config (provider);

