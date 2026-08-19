-- ── MIGRATION V8: Add user_id and post_url to social_posts ──
-- Paste and execute this script inside your Supabase SQL Editor.

-- 1. Add user_id and post_url columns to social_posts table
ALTER TABLE public.social_posts 
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS post_url text;

-- 2. Enable Row Level Security (RLS) if not already enabled
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;

-- 3. Re-create security policies to handle user_id matching
DROP POLICY IF EXISTS "Anyone can read social posts" ON public.social_posts;
CREATE POLICY "Anyone can read social posts"
  ON public.social_posts FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert social posts" ON public.social_posts;
CREATE POLICY "Authenticated users can insert social posts"
  ON public.social_posts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL OR true);

DROP POLICY IF EXISTS "Users can update their own posts" ON public.social_posts;
CREATE POLICY "Users can update their own posts"
  ON public.social_posts FOR UPDATE USING (auth.uid() = user_id);
