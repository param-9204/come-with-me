-- ── MIGRATION V38: Add place image storage and attribution to public.places ──
-- Run this in your Supabase SQL Editor
-- This adds array-based image columns to public.places and configures the public place_photos storage bucket.

BEGIN;

-- 1. Add image storage and attribution array columns to public.places (no single url columns)
ALTER TABLE public.places ADD COLUMN IF NOT EXISTS image_urls text[] DEFAULT '{}';
ALTER TABLE public.places ADD COLUMN IF NOT EXISTS image_attributions text[] DEFAULT '{}';
ALTER TABLE public.places ADD COLUMN IF NOT EXISTS image_source text DEFAULT 'google';
ALTER TABLE public.places ADD COLUMN IF NOT EXISTS image_fetched_at timestamptz DEFAULT now();

COMMENT ON COLUMN public.places.image_urls IS 'Array of up to 3 Google Places photo public URLs in Supabase Storage';
COMMENT ON COLUMN public.places.image_attributions IS 'Array of photographer / author attributions corresponding to each photo in image_urls';
COMMENT ON COLUMN public.places.image_source IS 'Origin source for place photos (strictly google)';

-- 2. Ensure public storage bucket exists for place photos
INSERT INTO storage.buckets (id, name, public)
VALUES ('place_photos', 'place_photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 3. Storage Policies
DO $$
BEGIN
  -- Allow public read access to place photos
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'Public Read Access for Place Photos'
  ) THEN
    CREATE POLICY "Public Read Access for Place Photos"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'place_photos');
  END IF;

  -- Allow service role full upload & manage access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'Service Role Upload Access for Place Photos'
  ) THEN
    CREATE POLICY "Service Role Upload Access for Place Photos"
    ON storage.objects FOR ALL
    TO service_role
    USING (bucket_id = 'place_photos')
    WITH CHECK (bucket_id = 'place_photos');
  END IF;
END $$;

-- 4. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
