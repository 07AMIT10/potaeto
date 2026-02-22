-- Content (generated assets)
create table if not exists public.content (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  entity_id uuid references public.entities (id) on delete set null,
  type text not null check (type in ('image', 'video', 'audio', 'text')),
  storage_path text,
  public_url text,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

alter table public.content enable row level security;

create policy "Users can do all on own content"
  on public.content for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index content_user_id on public.content (user_id);
create index content_entity_id on public.content (entity_id);
create index content_type on public.content (type);
create index content_created_at on public.content (created_at desc);
