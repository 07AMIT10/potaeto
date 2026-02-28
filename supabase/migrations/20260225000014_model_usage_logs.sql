create table if not exists public.model_usage_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  task_type text not null,
  provider text not null,
  model_key text not null,
  success boolean not null,
  latency_ms integer,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.model_usage_logs disable row level security;

