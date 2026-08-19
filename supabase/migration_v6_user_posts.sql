-- ── MIGRATION V6: Add user_id to social_posts and enable security policies ──

ALTER TABLE public.social_posts 
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Enable Row Level Security (RLS) if not already enabled
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Anyone can read social posts" ON public.social_posts;
DROP POLICY IF EXISTS "Authenticated users can insert social posts" ON public.social_posts;
DROP POLICY IF EXISTS "Authenticated users can update social posts" ON public.social_posts;
DROP POLICY IF EXISTS "Users can insert their own posts" ON public.social_posts;

-- Re-create security policies
CREATE POLICY "Anyone can read social posts"
  ON public.social_posts FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert social posts"
  ON public.social_posts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users can update their own posts"
  ON public.social_posts FOR UPDATE USING (auth.uid() = user_id);
