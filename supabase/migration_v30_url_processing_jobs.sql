-- Mobile URL jobs stored in the existing social_post_accesses table.
-- Apply after v28 and v29. Existing access-event rows are preserved.
-- For job rows, social_post_accesses.id is the mobile job ID and event='job'.

BEGIN;

ALTER TABLE public.social_post_accesses
  ALTER COLUMN social_post_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS client_request_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS run_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.social_post_accesses
  DROP CONSTRAINT IF EXISTS social_post_accesses_event_check,
  ADD CONSTRAINT social_post_accesses_event_check
    CHECK (event IN ('started', 'retry', 'joined_processing', 'cache_hit', 'job')),
  ADD CONSTRAINT social_post_accesses_job_status_check
    CHECK (status IS NULL OR status IN ('queued', 'processing', 'waiting', 'completed', 'failed')),
  ADD CONSTRAINT social_post_accesses_attempt_count_check
    CHECK (attempt_count >= 0),
  ADD CONSTRAINT social_post_accesses_max_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 5),
  ADD CONSTRAINT social_post_accesses_platform_check
    CHECK (platform IS NULL OR platform IN ('instagram', 'tiktok')),
  ADD CONSTRAINT social_post_accesses_job_shape_check
    CHECK (
      event <> 'job'
      OR (user_id IS NOT NULL AND client_request_id IS NOT NULL AND platform IS NOT NULL AND status IS NOT NULL)
    );

-- A client retry reuses its job row. Normal access-event rows keep a NULL
-- client_request_id and are not affected by this partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_post_accesses_user_client_request
  ON public.social_post_accesses (user_id, client_request_id)
  WHERE event = 'job';
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_ready_jobs
  ON public.social_post_accesses (run_after, created_at)
  WHERE event = 'job' AND status = 'queued';
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_job_user_time
  ON public.social_post_accesses (user_id, created_at DESC)
  WHERE event = 'job';
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_job_post
  ON public.social_post_accesses (social_post_id)
  WHERE event = 'job' AND social_post_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_url_processing_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 2
)
RETURNS SETOF public.social_post_accesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF nullif(trim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;

  UPDATE public.social_post_accesses
  SET
    status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
    run_after = now(),
    locked_at = NULL,
    locked_by = NULL,
    last_error = COALESCE(last_error, 'Worker lock expired before completion.'),
    updated_at = now()
  WHERE event = 'job'
    AND status = 'processing'
    AND locked_at < now() - interval '10 minutes';

  RETURN QUERY
  WITH next_jobs AS (
    SELECT id
    FROM public.social_post_accesses
    WHERE event = 'job'
      AND status = 'queued'
      AND run_after <= now()
      AND attempt_count < max_attempts
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2), 1), 3)
  ), claimed AS (
    UPDATE public.social_post_accesses access
    SET
      status = 'processing',
      attempt_count = access.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
    FROM next_jobs
    WHERE access.id = next_jobs.id
    RETURNING access.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_url_processing_jobs(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_url_processing_jobs(text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
