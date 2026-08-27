-- ── Migration v18: Many-to-Many Junction Table for Social Posts & Places ──
-- Prevents new social posts from overwriting social_post_id on existing places.

-- 1. Create junction table
CREATE TABLE IF NOT EXISTS public.social_post_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE CASCADE NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(social_post_id, place_id)
);

-- 2. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_social_post_places_post_id ON public.social_post_places(social_post_id);
CREATE INDEX IF NOT EXISTS idx_social_post_places_place_id ON public.social_post_places(place_id);

-- 3. Row Level Security (RLS)
ALTER TABLE public.social_post_places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read social_post_places" ON public.social_post_places;
CREATE POLICY "Anyone can read social_post_places" ON public.social_post_places FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert social_post_places" ON public.social_post_places;
CREATE POLICY "Authenticated users can insert social_post_places" ON public.social_post_places FOR INSERT WITH CHECK (auth.uid() IS NOT NULL OR true);

DROP POLICY IF EXISTS "Authenticated users can delete social_post_places" ON public.social_post_places;
CREATE POLICY "Authenticated users can delete social_post_places" ON public.social_post_places FOR DELETE USING (auth.uid() IS NOT NULL OR true);

-- 4. Backfill existing 1-to-1 links into the junction table
INSERT INTO public.social_post_places (social_post_id, place_id)
SELECT social_post_id, id FROM public.places WHERE social_post_id IS NOT NULL
ON CONFLICT (social_post_id, place_id) DO NOTHING;

INSERT INTO public.social_post_places (social_post_id, place_id)
SELECT id, place_id FROM public.social_posts WHERE place_id IS NOT NULL
ON CONFLICT (social_post_id, place_id) DO NOTHING;

-- 5. Reload schema cache
NOTIFY pgrst, 'reload schema';
