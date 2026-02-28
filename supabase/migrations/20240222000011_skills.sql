-- Catalog of skills that entities (nouns) can have
create table if not exists public.skills (
  id text primary key, -- e.g. 'songwriter', 'painter'
  name text not null,
  description text,
  icon text,
  category text,
  pipeline_config jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.skills enable row level security;

create policy "Skills readable by anyone"
  on public.skills for select
  using (true);

create policy "Admin manage skills"
  on public.skills for all
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

