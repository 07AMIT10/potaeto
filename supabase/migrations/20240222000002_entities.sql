-- Entities (WHO/WHAT)
create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  slug text not null,
  characteristics jsonb default '{}',
  appearance jsonb default '{}',
  persona jsonb default '{}',
  skills jsonb default '[]',
  attributes jsonb default '{}',
  avatar_asset_url text,
  is_public boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, slug)
);

alter table public.entities enable row level security;

create policy "Users can do all on own entities"
  on public.entities for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Public entities are readable by anyone"
  on public.entities for select
  using (is_public = true);

create index entities_user_id on public.entities (user_id);
create index entities_slug on public.entities (slug);
create unique index entities_user_slug on public.entities (user_id, slug);
