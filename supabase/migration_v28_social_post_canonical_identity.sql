-- One active social_posts row per platform/source URL. Apply after v27.
-- Existing duplicate rows are retained as audit rows and point to the chosen
-- canonical post; only their duplicate post-to-place links are consolidated.

BEGIN;

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS canonical_source_key text,
  ADD COLUMN IF NOT EXISTS merged_into_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL;

-- Backfill the same identity format used by /api/process-url. Instagram
-- shortcode and TikTok numeric-video URLs are stable across common URL forms.
UPDATE public.social_posts
SET canonical_source_key = CASE
  WHEN platform = 'instagram'
    AND post_url ~* '^https?://(?:www\.|m\.)?instagram\.com/(?:p|reel|reels|tv)/[^/?#]+'
    THEN 'instagram:' || (regexp_match(post_url, '^https?://(?:www\.|m\.)?instagram\.com/(?:p|reel|reels|tv)/([^/?#]+)', 'i'))[1]
  WHEN platform = 'tiktok'
    AND post_url ~* '^https?://(?:www\.|m\.)?tiktok\.com/@[^/]+/video/[0-9]+'
    THEN 'tiktok:' || (regexp_match(post_url, '^https?://(?:www\.|m\.)?tiktok\.com/@[^/]+/video/([0-9]+)', 'i'))[1]
  WHEN NULLIF(post_url, '') IS NOT NULL
    THEN platform || ':' || regexp_replace(regexp_replace(split_part(post_url, '?', 1), '^https?://(?:www\.|m\.)?', '', 'i'), '/+$', '')
  ELSE NULL
END
WHERE canonical_source_key IS NULL;

-- A previously merged row is never an active URL owner.
UPDATE public.social_posts
SET canonical_source_key = NULL
WHERE merged_into_post_id IS NOT NULL;

-- Consolidate junction links onto a deterministic canonical row before the
-- duplicate rows lose their identity key. Prefer a completed real content ID.
WITH ranked AS (
  SELECT
    id,
    platform,
    canonical_source_key,
    first_value(id) OVER (
      PARTITION BY platform, canonical_source_key
      ORDER BY
        CASE WHEN status = 'completed' AND content_id NOT LIKE 'pending\_%' THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
    ) AS canonical_id
  FROM public.social_posts
  WHERE canonical_source_key IS NOT NULL
), duplicate_links AS (
  SELECT DISTINCT ranked.canonical_id AS social_post_id, spp.place_id
  FROM ranked
  JOIN public.social_post_places spp ON spp.social_post_id = ranked.id
  WHERE ranked.id <> ranked.canonical_id
)
INSERT INTO public.social_post_places (social_post_id, place_id)
SELECT social_post_id, place_id
FROM duplicate_links
ON CONFLICT (social_post_id, place_id) DO NOTHING;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY platform, canonical_source_key
      ORDER BY
        CASE WHEN status = 'completed' AND content_id NOT LIKE 'pending\_%' THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
    ) AS canonical_id
  FROM public.social_posts
  WHERE canonical_source_key IS NOT NULL
)
UPDATE public.social_posts duplicate
SET
  merged_into_post_id = ranked.canonical_id,
  canonical_source_key = NULL,
  status = 'merged'
FROM ranked
WHERE duplicate.id = ranked.id
  AND duplicate.id <> ranked.canonical_id;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'social_posts_platform_canonical_source_key_key'
      AND conrelid = 'public.social_posts'::regclass
  ) THEN
    ALTER TABLE public.social_posts
      ADD CONSTRAINT social_posts_platform_canonical_source_key_key
      UNIQUE (platform, canonical_source_key);
  END IF;
END
$constraint$;

CREATE INDEX IF NOT EXISTS idx_social_posts_merged_into_post
  ON public.social_posts (merged_into_post_id)
  WHERE merged_into_post_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
