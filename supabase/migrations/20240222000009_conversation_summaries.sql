-- Rolling summaries per conversation
create table if not exists public.conversation_summaries (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  summary text not null,
  last_message_id uuid references public.messages (id) on delete set null,
  updated_at timestamptz default now()
);

alter table public.conversation_summaries enable row level security;

create policy "Users can manage own conversation summaries"
  on public.conversation_summaries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

