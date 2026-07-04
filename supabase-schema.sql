-- Loop — database schema. Run this once in the Supabase SQL Editor.
-- Every row is tied to a user_id from Supabase Auth, so each person only ever sees their own data.

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  due         timestamptz,
  due_phrase  text,
  priority    text not null default 'medium',
  bucket      text, -- 'deep_work' | 'admin' | 'survival' (student triage)
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  title            text not null,
  start            timestamptz,
  start_phrase     text,
  duration_minutes integer,
  created_at       timestamptz not null default now()
);

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  text        text not null,
  mood        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  summary     text not null default '',
  log         jsonb not null default '[]'::jsonb,
  energy      text, -- 'morning' | 'night' — when this student's brain works best
  updated_at  timestamptz not null default now()
);

-- Per-user Google Calendar OAuth tokens. Only the server (service key) ever touches this.
create table if not exists public.google_accounts (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.google_accounts enable row level security;

-- Speed up the per-user lookups the app does constantly.
create index if not exists tasks_user_idx  on public.tasks(user_id);
create index if not exists events_user_idx on public.events(user_id);
create index if not exists notes_user_idx  on public.notes(user_id);

-- Lock the tables down. The browser NEVER queries these directly — only our server does,
-- using the service key (which bypasses RLS). Turning RLS on with no public policies means
-- that even if someone got hold of the public anon key, they still can't read anyone's data.
alter table public.tasks    enable row level security;
alter table public.events   enable row level security;
alter table public.notes    enable row level security;
alter table public.profiles enable row level security;
