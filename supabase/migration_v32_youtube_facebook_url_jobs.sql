-- Allow YouTube Shorts and Facebook Reels through the existing mobile URL-job queue.
-- Apply after migration_v31_remove_client_request_id.sql.

BEGIN;

ALTER TABLE public.social_post_accesses
  DROP CONSTRAINT IF EXISTS social_post_accesses_platform_check,
  ADD CONSTRAINT social_post_accesses_platform_check
    CHECK (platform IS NULL OR platform IN ('instagram', 'tiktok', 'youtube', 'facebook'));

NOTIFY pgrst, 'reload schema';

COMMIT;
