-- ── MIGRATION: CREATE GUIDES & GUIDE_PLACES TABLES 🗺️ ──
-- Paste and execute this script inside your Supabase SQL Editor.

-- 1. Create public.guides table
create table if not exists public.guides (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  creator_name text,
  creator_handle text,
  title text not null,
  destination text,
  intro text,
  cover_image_url text,
  cover_emoji text,
  is_published boolean default false,
  created_at timestamptz default now()
);

-- 2. Create public.guide_places table
create table if not exists public.guide_places (
  id uuid primary key default gen_random_uuid(),
  guide_id uuid references public.guides(id) on delete cascade not null,
  name text not null,
  category text,
  neighborhood text,
  city text,
  description text,
  address text,
  google_maps_url text,
  image_url text,
  time_of_day text,
  latitude double precision,
  longitude double precision,
  position integer default 0,
  created_at timestamptz default now()
);

-- 3. Enable Row Level Security (RLS)
alter table public.guides enable row level security;
alter table public.guide_places enable row level security;

-- 4. RLS Policies for public.guides
drop policy if exists "Anyone can view published guides" on public.guides;
create policy "Anyone can view published guides"
  on public.guides for select using (is_published = true or auth.uid() is not null);

drop policy if exists "Authenticated users can create/manage guides" on public.guides;
create policy "Authenticated users can create/manage guides"
  on public.guides for all using (auth.uid() is not null);

-- 5. RLS Policies for public.guide_places
drop policy if exists "Anyone can view guide places" on public.guide_places;
create policy "Anyone can view guide places"
  on public.guide_places for select using (
    guide_id in (select id from public.guides where is_published = true or auth.uid() is not null)
  );

drop policy if exists "Authenticated users can manage guide places" on public.guide_places;
create policy "Authenticated users can manage guide places"
  on public.guide_places for all using (auth.uid() is not null);
