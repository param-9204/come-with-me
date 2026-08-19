-- 1. SOCIAL POSTS TABLE
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  place_id uuid references public.places(id) on delete set null,
  platform text not null, -- 'tiktok', 'instagram'
  content_type text, -- 'video', 'reel', 'post'
  content_id text not null, -- The original post ID
  author_username text,
  caption text,
  video_url text,
  likes integer default 0,
  views integer default 0,
  comments integer default 0,
  created_at timestamptz default now(),
  unique(platform, content_id)
);

-- Enable RLS
alter table public.social_posts enable row level security;

-- Policies
create policy "Anyone can read social posts"
  on public.social_posts for select using (true);

create policy "Authenticated users can insert social posts"
  on public.social_posts for insert with check (true); -- Note: our pipeline uses service_role key which bypasses RLS anyway

create policy "Authenticated users can update social posts"
  on public.social_posts for update using (true);
