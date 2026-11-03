-- ── MIGRATION V37: Add thumbnail_url to social_posts and uploaded_images ──
-- Run this in your Supabase SQL Editor
-- This adds the thumbnail_url column to public.social_posts and public.uploaded_images,
-- and backfills existing rows with the first image / cover URL.

BEGIN;

-- 1. Add thumbnail_url column to social_posts table
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS thumbnail_url text;

COMMENT ON COLUMN public.social_posts.thumbnail_url IS 'Thumbnail image URL extracted from raw Apify scraper data';

-- 2. Backfill thumbnail_url for existing social_posts rows where raw_apify_data or display_url is present
UPDATE public.social_posts
SET thumbnail_url = COALESCE(
  raw_apify_data->>'thumbnailUrl',
  raw_apify_data->>'thumbnail_url',
  raw_apify_data->>'thumbnail',
  raw_apify_data->'videoMeta'->>'originalCoverUrl',
  raw_apify_data->'videoMeta'->>'coverUrl',
  raw_apify_data->'videoMeta'->>'dynamicCoverUrl',
  raw_apify_data->>'coverUrl',
  raw_apify_data->>'originalCoverUrl',
  raw_apify_data->>'displayUrl',
  raw_apify_data->>'imageUrl',
  raw_apify_data->>'imageURL',
  display_url
)
WHERE thumbnail_url IS NULL AND (raw_apify_data IS NOT NULL OR display_url IS NOT NULL);

-- 3. Add thumbnail_url column to uploaded_images table
ALTER TABLE public.uploaded_images
  ADD COLUMN IF NOT EXISTS thumbnail_url text;

COMMENT ON COLUMN public.uploaded_images.thumbnail_url IS 'Thumbnail image URL (first image URL for multi-image uploads)';

-- 4. Backfill thumbnail_url for existing uploaded_images rows with the 1st image URL
UPDATE public.uploaded_images
SET thumbnail_url = image_urls[1]
WHERE thumbnail_url IS NULL AND array_length(image_urls, 1) > 0;

-- 5. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
