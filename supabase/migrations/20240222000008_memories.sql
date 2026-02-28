-- Long-term distilled memories and facts for a user+entity
create extension if not exists vector;

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  kind text not null check (kind in ('summary', 'fact', 'preference', 'event')),
  content text not null,
  embedding vector(1536),
  weight real default 1.0,
  created_at timestamptz default now()
);

alter table public.memories enable row level security;

create policy "Users can manage own memories"
  on public.memories for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists memories_user_entity on public.memories (user_id, entity_id);
create index if not exists memories_kind on public.memories (kind);
create index if not exists memories_created_at on public.memories (created_at desc);

