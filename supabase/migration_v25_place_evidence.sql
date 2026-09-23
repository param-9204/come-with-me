-- ── Migration v25: Multi-signal place extraction ──
-- 1. places.google_place_id: stable Google Places id, used to deduplicate the
--    same venue saved under different spellings or from different posts.
-- 2. social_post_places.confidence / explanation / evidence: why a place was
--    detected in a specific post (the same place can be found via different
--    signals in different posts, so this lives on the link, not the place).
--
-- The application detects these columns at runtime and works without them;
-- apply this migration to enable place-id dedup and stored explanations.

ALTER TABLE public.places ADD COLUMN IF NOT EXISTS google_place_id text;

-- Partial unique index: legacy rows without an id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS places_google_place_id_unique
  ON public.places (google_place_id)
  WHERE google_place_id IS NOT NULL;

ALTER TABLE public.social_post_places ADD COLUMN IF NOT EXISTS confidence numeric(4, 3);
ALTER TABLE public.social_post_places ADD COLUMN IF NOT EXISTS explanation text;
ALTER TABLE public.social_post_places ADD COLUMN IF NOT EXISTS evidence jsonb;

-- Reload PostgREST schema cache so the new columns are visible immediately.
NOTIFY pgrst, 'reload schema';
