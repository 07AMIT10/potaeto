-- Admin: allow listing metrics via service role or an admin flag
-- For MVP we use service role in API route with ADMIN_SECRET env check; no extra table needed.
-- Optional: admin_emails for role-based admin UI access
create table if not exists public.admin_emails (
  email text primary key,
  created_at timestamptz default now()
);

alter table public.admin_emails enable row level security;

-- Only service role can read (no policy = no access with anon key)
-- API routes using createServiceClient() can read admin_emails when checking auth.
