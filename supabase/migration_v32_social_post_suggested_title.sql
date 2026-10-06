-- AI-generated, factual 4–5 word title for the overall social post.
-- Existing posts remain null; cache responses never generate or backfill a title.

BEGIN;

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS suggested_title text;

-- Do not replace social_posts_enriched here: live deployments can have a
-- different historical view column order, while this API reads social_posts
-- directly. Fresh databases expose the field through complete_schema.sql.

NOTIFY pgrst, 'reload schema';

COMMIT;
