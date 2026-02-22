-- Storage buckets: avatars, content
-- Run in Supabase SQL editor or via API; RLS for storage is set via dashboard or below.

insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', true),
  ('content', 'content', true)
on conflict (id) do update set public = true;

-- RLS for storage: users can upload to their own paths
create policy "Users can upload own avatars"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update own avatars"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Anyone can read avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users can upload own content"
  on storage.objects for insert
  with check (
    bucket_id = 'content'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update own content"
  on storage.objects for update
  using (
    bucket_id = 'content'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Anyone can read content"
  on storage.objects for select
  using (bucket_id = 'content');
