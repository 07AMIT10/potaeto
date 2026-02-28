-- Conversations between a user and a specific entity (noun)
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, entity_id)
);

alter table public.conversations enable row level security;

create policy "Users can manage own conversations"
  on public.conversations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists conversations_user_id on public.conversations (user_id);
create index if not exists conversations_entity_id on public.conversations (entity_id);

