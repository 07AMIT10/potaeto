-- Individual messages within a conversation
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

create policy "Users can manage own messages"
  on public.messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists messages_conversation_id on public.messages (conversation_id);
create index if not exists messages_user_id on public.messages (user_id);
create index if not exists messages_created_at on public.messages (created_at);

