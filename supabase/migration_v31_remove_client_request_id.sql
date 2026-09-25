-- Remove client-generated idempotency keys from mobile URL jobs.
-- Apply after v30. social_post_accesses.id is the server-generated job ID.

BEGIN;

DROP INDEX IF EXISTS public.idx_social_post_accesses_user_client_request;

ALTER TABLE public.social_post_accesses
  DROP CONSTRAINT IF EXISTS social_post_accesses_job_shape_check;

ALTER TABLE public.social_post_accesses
  DROP COLUMN IF EXISTS client_request_id;

ALTER TABLE public.social_post_accesses
  ADD CONSTRAINT social_post_accesses_job_shape_check
    CHECK (
      event <> 'job'
      OR (user_id IS NOT NULL AND platform IS NOT NULL AND status IS NOT NULL)
    );

NOTIFY pgrst, 'reload schema';

COMMIT;
