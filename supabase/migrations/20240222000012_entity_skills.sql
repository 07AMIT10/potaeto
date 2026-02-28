-- Mapping of which skills a given entity has
create table if not exists public.entity_skills (
  entity_id uuid not null references public.entities (id) on delete cascade,
  skill_id text not null references public.skills (id) on delete cascade,
  config jsonb default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (entity_id, skill_id)
);

alter table public.entity_skills enable row level security;

create policy "Users manage skills for own entities"
  on public.entity_skills for all
  using (auth.uid() in (select user_id from public.entities where id = entity_id))
  with check (auth.uid() in (select user_id from public.entities where id = entity_id));

