-- Migration v11: Add social_post_id to places table to support direct One-to-Many linking

ALTER TABLE public.places 
ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE CASCADE;

-- Create an index to optimize joins
CREATE INDEX IF NOT EXISTS idx_places_social_post_id ON public.places(social_post_id);
