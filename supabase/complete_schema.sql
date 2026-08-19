-- ── COMPLETE DATABASE SCHEMA FOR COME WITH ME 🗺️ ──
-- Paste and execute this consolidated script inside your Supabase SQL Editor.

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. PROFILES TABLE
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text UNIQUE,
  display_name text,
  avatar_url text,
  role text DEFAULT 'explorer', -- explorer | creator | brand
  home_city text DEFAULT 'New York',
  bio text,
  created_at timestamptz DEFAULT now()
);

-- 3. PLACES TABLE
CREATE TABLE IF NOT EXISTS public.places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT null,
  address text,
  neighborhood text,
  city text DEFAULT 'New York',
  category text,
  description text,
  creator_handle text,
  source text, -- tiktok | instagram | discovery
  latitude double precision,
  longitude double precision,
  source_url text,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  audio_transcript text,
  created_at timestamptz DEFAULT now()
);

-- 4. SOCIAL POSTS TABLE
CREATE TABLE IF NOT EXISTS public.social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id uuid REFERENCES public.places(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  platform text NOT null, -- 'tiktok', 'instagram'
  content_type text, -- 'video', 'reel', 'post'
  content_id text NOT null, -- The original post ID
  author_username text,
  caption text,
  video_url text,
  likes integer DEFAULT 0,
  views integer DEFAULT 0,
  comments integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  -- Full intelligence pipeline analysis columns
  raw_apify_data jsonb,
  ai_analysis jsonb,
  ocr_frames_apify jsonb,
  ocr_frames_gpt jsonb,
  whisper_transcript text,
  video_plays integer,
  video_duration integer,
  dimensions_width integer,
  dimensions_height integer,
  hashtags text[],
  mentions text[],
  tagged_users jsonb,
  music_info jsonb,
  mentioned_brands text[],
  mentioned_locations text[],
  primary_category text,
  secondary_categories text[],
  content_summary text,
  is_promotional boolean,
  is_paid_partnership boolean,
  owner_full_name text,
  short_code text,
  product_type text,
  engagement_rate numeric(8,4),
  ocr_combined_text text,
  display_url text,
  first_comment text,
  niche text,
  target_audience text,
  call_to_actions text[],
  post_url text,
  UNIQUE(platform, content_id)
);

-- 5. SAVED PLACES TABLE (Likes / Favorites)
CREATE TABLE IF NOT EXISTS public.saved_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT null,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT null,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, place_id)
);

-- 6. LISTS TABLE
CREATE TABLE IF NOT EXISTS public.lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT null,
  name text NOT null,
  description text,
  is_private boolean DEFAULT false,
  gradient text DEFAULT 'from-purple-800 to-indigo-900',
  emoji text DEFAULT '📍',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 7. LIST PLACES JUNCTION TABLE
CREATE TABLE IF NOT EXISTS public.list_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES public.lists(id) ON DELETE CASCADE NOT null,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT null,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(list_id, place_id)
);

-- 8. LIST COLLABORATORS TABLE
CREATE TABLE IF NOT EXISTS public.list_collaborators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES public.lists(id) ON DELETE CASCADE NOT null,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT null,
  role text DEFAULT 'editor', -- editor | viewer
  created_at timestamptz DEFAULT now(),
  UNIQUE(list_id, user_id)
);

-- 9. GUIDES TABLE
CREATE TABLE IF NOT EXISTS public.guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT null UNIQUE,
  creator_name text,
  creator_handle text,
  title text NOT null,
  destination text,
  intro text,
  cover_image_url text,
  cover_emoji text,
  is_published boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 10. GUIDE PLACES TABLE
CREATE TABLE IF NOT EXISTS public.guide_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid REFERENCES public.guides(id) ON DELETE CASCADE NOT null,
  name text NOT null,
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
  position integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 11. FOLLOWS TABLE
CREATE TABLE IF NOT EXISTS public.follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT null,
  following_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT null,
  created_at timestamptz DEFAULT now(),
  UNIQUE(follower_id, following_id)
);

-- 12. WAITLIST TABLE
CREATE TABLE IF NOT EXISTS public.waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT null UNIQUE,
  city text,
  role text DEFAULT 'explorer', -- explorer | creator | brand
  phone text,
  created_at timestamptz DEFAULT now()
);


-- 13. CITIES TABLE
CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT null UNIQUE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read cities" ON public.cities;
CREATE POLICY "Anyone can read cities" ON public.cities FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert cities" ON public.cities;
CREATE POLICY "Authenticated users can insert cities" ON public.cities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);


-- ── 13. INDEXES FOR PERFORMANCE ──

CREATE INDEX IF NOT EXISTS idx_social_posts_hashtags ON public.social_posts USING gin(hashtags);
CREATE INDEX IF NOT EXISTS idx_social_posts_brands ON public.social_posts USING gin(mentioned_brands);
CREATE INDEX IF NOT EXISTS idx_social_posts_raw_apify ON public.social_posts USING gin(raw_apify_data);
CREATE INDEX IF NOT EXISTS idx_social_posts_ai_analysis ON public.social_posts USING gin(ai_analysis);
CREATE INDEX IF NOT EXISTS idx_social_posts_ocr_text ON public.social_posts USING gin(to_tsvector('english', coalesce(ocr_combined_text, '')));
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON public.social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_engagement ON public.social_posts(engagement_rate DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_places_user_id ON public.places(user_id);
CREATE INDEX IF NOT EXISTS idx_places_category ON public.places(category);


-- ── 14. ROW LEVEL SECURITY (RLS) & POLICIES ──

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guide_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- profiles policies
DROP POLICY IF EXISTS "Anyone can read profiles" ON public.profiles;
CREATE POLICY "Anyone can read profiles" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (id = auth.uid());

-- places policies
DROP POLICY IF EXISTS "Anyone can read places" ON public.places;
CREATE POLICY "Anyone can read places" ON public.places FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert places" ON public.places;
CREATE POLICY "Authenticated users can insert places" ON public.places FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- social_posts policies
DROP POLICY IF EXISTS "Anyone can read social posts" ON public.social_posts;
CREATE POLICY "Anyone can read social posts" ON public.social_posts FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert social posts" ON public.social_posts;
CREATE POLICY "Authenticated users can insert social posts" ON public.social_posts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Users can update their own posts" ON public.social_posts;
CREATE POLICY "Users can update their own posts" ON public.social_posts FOR UPDATE USING (auth.uid() = user_id);

-- saved_places policies
DROP POLICY IF EXISTS "Users can view their saved places" ON public.saved_places;
CREATE POLICY "Users can view their saved places" ON public.saved_places FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their saved places" ON public.saved_places;
CREATE POLICY "Users can insert their saved places" ON public.saved_places FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their saved places" ON public.saved_places;
CREATE POLICY "Users can delete their saved places" ON public.saved_places FOR DELETE USING (auth.uid() = user_id);

-- lists policies
DROP POLICY IF EXISTS "Users can view their own lists and shared lists" ON public.lists;
CREATE POLICY "Users can view their own lists and shared lists" ON public.lists FOR SELECT USING (
  owner_id = auth.uid()
  OR id IN (SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid())
  OR is_private = false
);

DROP POLICY IF EXISTS "Users can create their own lists" ON public.lists;
CREATE POLICY "Users can create their own lists" ON public.lists FOR INSERT WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Owners can update their lists" ON public.lists;
CREATE POLICY "Owners can update their lists" ON public.lists FOR UPDATE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Owners can delete their lists" ON public.lists;
CREATE POLICY "Owners can delete their lists" ON public.lists FOR DELETE USING (owner_id = auth.uid());

-- list_places policies
DROP POLICY IF EXISTS "Users can view places in accessible lists" ON public.list_places;
CREATE POLICY "Users can view places in accessible lists" ON public.list_places FOR SELECT USING (
  list_id IN (
    SELECT id FROM public.lists WHERE
      owner_id = auth.uid()
      OR id IN (SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid())
      OR is_private = false
  )
);

DROP POLICY IF EXISTS "List owners and collaborators can add places" ON public.list_places;
CREATE POLICY "List owners and collaborators can add places" ON public.list_places FOR INSERT WITH CHECK (
  list_id IN (
    SELECT id FROM public.lists WHERE owner_id = auth.uid()
    UNION
    SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid() AND role = 'editor'
  )
);

DROP POLICY IF EXISTS "List owners and collaborators can remove places" ON public.list_places;
CREATE POLICY "List owners and collaborators can remove places" ON public.list_places FOR DELETE USING (
  list_id IN (
    SELECT id FROM public.lists WHERE owner_id = auth.uid()
    UNION
    SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid() AND role = 'editor'
  )
);

-- list_collaborators policies
DROP POLICY IF EXISTS "Users can view list collaborators" ON public.list_collaborators;
CREATE POLICY "Users can view list collaborators" ON public.list_collaborators FOR SELECT USING (
  list_id IN (SELECT id FROM public.lists WHERE owner_id = auth.uid())
  OR user_id = auth.uid()
);

DROP POLICY IF EXISTS "Owners can invite collaborators" ON public.list_collaborators;
CREATE POLICY "Owners can invite collaborators" ON public.list_collaborators FOR INSERT WITH CHECK (
  list_id IN (SELECT id FROM public.lists WHERE owner_id = auth.uid())
);

DROP POLICY IF EXISTS "Owners can remove collaborators" ON public.list_collaborators;
CREATE POLICY "Owners can remove collaborators" ON public.list_collaborators FOR DELETE USING (
  list_id IN (SELECT id FROM public.lists WHERE owner_id = auth.uid())
);

-- guides policies
DROP POLICY IF EXISTS "Anyone can view published guides" ON public.guides;
CREATE POLICY "Anyone can view published guides" ON public.guides FOR SELECT USING (is_published = true OR auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can create/manage guides" ON public.guides;
CREATE POLICY "Authenticated users can create/manage guides" ON public.guides FOR ALL USING (auth.uid() IS NOT NULL);

-- guide_places policies
DROP POLICY IF EXISTS "Anyone can view guide places" ON public.guide_places;
CREATE POLICY "Anyone can view guide places" ON public.guide_places FOR SELECT USING (
  guide_id IN (SELECT id FROM public.guides WHERE is_published = true OR auth.uid() IS NOT NULL)
);

DROP POLICY IF EXISTS "Authenticated users can manage guide places" ON public.guide_places;
CREATE POLICY "Authenticated users can manage guide places" ON public.guide_places FOR ALL USING (auth.uid() IS NOT NULL);

-- follows policies
DROP POLICY IF EXISTS "Anyone can read follows" ON public.follows;
CREATE POLICY "Anyone can read follows" ON public.follows FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can follow others" ON public.follows;
CREATE POLICY "Users can follow others" ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);

DROP POLICY IF EXISTS "Users can unfollow others" ON public.follows;
CREATE POLICY "Users can unfollow others" ON public.follows FOR DELETE USING (auth.uid() = follower_id);

-- waitlist policies
DROP POLICY IF EXISTS "Anyone can join waitlist" ON public.waitlist;
CREATE POLICY "Anyone can join waitlist" ON public.waitlist FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Only admin can view waitlist details" ON public.waitlist;
CREATE POLICY "Only admin can view waitlist details" ON public.waitlist FOR SELECT USING (auth.uid() IN (
  SELECT id FROM public.profiles WHERE handle = 'admin'
));


-- ── 15. TRIGGERS & PL/PGSQL FUNCTIONS ──

-- Automatically create profile on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, role)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'Explorer'),
    coalesce(new.raw_user_meta_data->>'role', 'explorer')
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- ── 16. VIEW FOR EASY ENRICHED QUERIES ──

CREATE OR REPLACE VIEW public.social_posts_enriched AS
SELECT
  sp.id,
  sp.platform,
  sp.content_type,
  sp.content_id,
  sp.author_username,
  sp.owner_full_name,
  sp.short_code,
  sp.caption,
  sp.video_url,
  sp.display_url,
  sp.likes,
  sp.views,
  sp.comments,
  sp.video_plays,
  sp.video_duration,
  sp.dimensions_width,
  sp.dimensions_height,
  sp.hashtags,
  sp.mentions,
  sp.tagged_users,
  sp.music_info,
  sp.mentioned_brands,
  sp.mentioned_locations,
  sp.primary_category,
  sp.secondary_categories,
  sp.content_summary,
  sp.is_promotional,
  sp.is_paid_partnership,
  sp.engagement_rate,
  sp.niche,
  sp.target_audience,
  sp.call_to_actions,
  sp.ocr_combined_text,
  sp.whisper_transcript,
  sp.created_at,
  -- Place details joined
  p.name AS place_name,
  p.city AS place_city,
  p.neighborhood AS place_neighborhood,
  p.category AS place_category,
  p.latitude,
  p.longitude,
  p.address AS place_address
FROM public.social_posts sp
LEFT JOIN public.places p ON sp.place_id = p.id;
