-- Run this in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/YOUR_PROJECT_ID/sql

-- 1. Add missing columns to places table
alter table places
  add column if not exists address text,
  add column if not exists source_url text,
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists audio_transcript text;

-- 2. Lists table (if not already created)
create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  description text,
  is_private boolean default false,
  gradient text default 'from-purple-800 to-indigo-900',
  emoji text default '📍',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3. List places junction table
create table if not exists list_places (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references lists(id) on delete cascade not null,
  place_id uuid references places(id) on delete cascade not null,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  unique(list_id, place_id)
);

-- 4. List collaborators table
create table if not exists list_collaborators (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references lists(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  role text default 'editor', -- editor | viewer
  created_at timestamptz default now(),
  unique(list_id, user_id)
);

-- 5. Enable RLS
alter table lists enable row level security;
alter table list_places enable row level security;
alter table list_collaborators enable row level security;

-- 6. RLS policies for lists
create policy "Users can view their own lists and shared lists"
  on lists for select using (
    owner_id = (select auth.uid())
    or id in (
      select list_id from list_collaborators where user_id = (select auth.uid())
    )
    or is_private = false
  );

create policy "Users can create their own lists"
  on lists for insert with check (owner_id = (select auth.uid()));

create policy "Owners can update their lists"
  on lists for update using (owner_id = (select auth.uid()));

create policy "Owners can delete their lists"
  on lists for delete using (owner_id = (select auth.uid()));

-- 7. RLS policies for list_places
create policy "Users can view places in accessible lists"
  on list_places for select using (
    list_id in (
      select id from lists where
        owner_id = (select auth.uid())
        or id in (select list_id from list_collaborators where user_id = (select auth.uid()))
        or is_private = false
    )
  );

create policy "List owners and collaborators can add places"
  on list_places for insert with check (
    list_id in (
      select id from lists where owner_id = (select auth.uid())
      union
      select list_id from list_collaborators where user_id = (select auth.uid()) and role = 'editor'
    )
  );

create policy "List owners and collaborators can remove places"
  on list_places for delete using (
    list_id in (
      select id from lists where owner_id = (select auth.uid())
      union
      select list_id from list_collaborators where user_id = (select auth.uid()) and role = 'editor'
    )
  );

-- 8. User profiles table (needed for @handles)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique,
  display_name text,
  avatar_url text,
  role text default 'explorer', -- explorer | creator | brand
  home_city text default 'New York',
  bio text,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

drop policy if exists "Anyone can read profiles" on profiles;
create policy "Anyone can read profiles"
  on profiles for select using (true);

drop policy if exists "Users can update their own profile" on profiles;
create policy "Users can update their own profile"
  on profiles for update using (id = (select auth.uid()));

drop policy if exists "Users can insert their own profile" on profiles;
create policy "Users can insert their own profile"
  on profiles for insert with check (id = (select auth.uid()));

-- 9. Auto-create profile on signup (run as a trigger)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'Explorer'),
    coalesce(new.raw_user_meta_data->>'role', 'explorer')
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- 10. Follows table (New)
create table if not exists follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid references auth.users(id) on delete cascade not null,
  following_id uuid references auth.users(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique(follower_id, following_id)
);

alter table follows enable row level security;

drop policy if exists "Anyone can read follows" on follows;
create policy "Anyone can read follows"
  on follows for select using (true);

drop policy if exists "Users can follow others" on follows;
create policy "Users can follow others"
  on follows for insert with check ((select auth.uid()) = follower_id);

drop policy if exists "Users can unfollow others" on follows;
create policy "Users can unfollow others"
  on follows for delete using ((select auth.uid()) = follower_id);
