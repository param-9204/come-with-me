-- Run this in the Supabase SQL editor at:
-- https://supabase.com/dashboard/project/cuxsjhpjmnikvdnpyntv/sql

-- Places table
create table if not exists places (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  neighborhood text,
  city text default 'New York',
  category text,
  description text,
  creator_handle text,
  source text, -- tiktok | instagram | discovery
  latitude double precision,
  longitude double precision,
  source_url text,
  user_id uuid references auth.users(id) on delete set null,
  audio_transcript text,
  created_at timestamptz default now()
);

-- Saved places (links users to places)
create table if not exists saved_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  place_id uuid references places(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique(user_id, place_id)
);

-- Enable Row Level Security
alter table places enable row level security;
alter table saved_places enable row level security;

-- Places: anyone can read and insert (insert is controlled at app level via auth)
create policy "Anyone can read places"
  on places for select using (true);

create policy "Authenticated users can insert places"
  on places for insert with check ((select auth.uid()) is not null);

-- Saved places: users can only see and manage their own
create policy "Users can view their saved places"
  on saved_places for select using ((select auth.uid()) = user_id);

create policy "Users can insert their saved places"
  on saved_places for insert with check ((select auth.uid()) = user_id);

create policy "Users can delete their saved places"
  on saved_places for delete using ((select auth.uid()) = user_id);
