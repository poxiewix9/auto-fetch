-- Internship Tracker schema
-- Run in the Supabase SQL Editor (or via `supabase db push`).

-- ---------------------------------------------------------------------------
-- Gmail refresh tokens (one per user) used for server-side background syncing.
-- ---------------------------------------------------------------------------
create table if not exists public.gmail_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Applications: one row per (company + role) the user applied to.
-- ---------------------------------------------------------------------------
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company text not null,
  role text,
  stage text not null default 'applied'
    check (stage in ('applied', 'oa', 'interview', 'offer', 'rejected')),
  dedup_key text not null,
  first_email_at timestamptz not null default now(),
  last_email_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dedup_key)
);

create index if not exists applications_user_idx on public.applications (user_id);

-- ---------------------------------------------------------------------------
-- Per-email events that feed into an application's current stage.
-- ---------------------------------------------------------------------------
create table if not exists public.application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stage text not null
    check (stage in ('applied', 'oa', 'interview', 'offer', 'rejected')),
  subject text,
  sender text,
  snippet text,
  gmail_message_id text not null,
  email_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, gmail_message_id)
);

create index if not exists application_events_app_idx
  on public.application_events (application_id);

-- ---------------------------------------------------------------------------
-- Per-user sync bookkeeping.
-- ---------------------------------------------------------------------------
create table if not exists public.sync_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_synced_at timestamptz,
  last_history_id text,
  status text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: every user only sees their own rows.
-- ---------------------------------------------------------------------------
alter table public.gmail_tokens enable row level security;
alter table public.applications enable row level security;
alter table public.application_events enable row level security;
alter table public.sync_state enable row level security;

do $$
begin
  -- gmail_tokens
  if not exists (select 1 from pg_policies where policyname = 'gmail_tokens_owner') then
    create policy gmail_tokens_owner on public.gmail_tokens
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- applications
  if not exists (select 1 from pg_policies where policyname = 'applications_owner') then
    create policy applications_owner on public.applications
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- application_events
  if not exists (select 1 from pg_policies where policyname = 'application_events_owner') then
    create policy application_events_owner on public.application_events
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- sync_state
  if not exists (select 1 from pg_policies where policyname = 'sync_state_owner') then
    create policy sync_state_owner on public.sync_state
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
