-- Migration v24: Add social_post_id column to saved_places table
-- This allows saved places to be explicitly linked back to the specific social post they were saved from.

ALTER TABLE public.saved_places 
ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_saved_places_social_post_id ON public.saved_places(social_post_id);
