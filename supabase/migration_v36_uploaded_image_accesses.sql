-- Apply after v30/v31, v32_youtube_facebook_url_jobs, and v34_image_uploads.
-- Image IDs remain stable mobile job IDs. Synchronization is atomic with the
-- upload insert/update, including background completion and failure recording.
BEGIN;

ALTER TABLE public.social_post_accesses
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE CASCADE;

ALTER TABLE public.social_post_accesses
  DROP CONSTRAINT IF EXISTS social_post_accesses_platform_check,
  ADD CONSTRAINT social_post_accesses_platform_check
    CHECK (platform IS NULL OR platform IN ('instagram', 'tiktok', 'youtube', 'facebook', 'upload')),
  DROP CONSTRAINT IF EXISTS social_post_accesses_job_shape_check,
  ADD CONSTRAINT social_post_accesses_job_shape_check CHECK (
    event <> 'job' OR (
      platform IS NOT NULL AND status IS NOT NULL
      AND (user_id IS NOT NULL OR uploaded_image_id IS NOT NULL)
    )
  ),
  DROP CONSTRAINT IF EXISTS social_post_accesses_image_source_check,
  ADD CONSTRAINT social_post_accesses_image_source_check CHECK (
    (uploaded_image_id IS NULL AND (platform IS NULL OR platform <> 'upload'))
    OR (uploaded_image_id IS NOT NULL AND social_post_id IS NULL
      AND platform IS NOT NULL AND platform = 'upload')
  );

CREATE INDEX IF NOT EXISTS idx_social_post_accesses_image_time
  ON public.social_post_accesses (uploaded_image_id, created_at DESC)
  WHERE uploaded_image_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_post_accesses_image_job
  ON public.social_post_accesses (uploaded_image_id)
  WHERE event = 'job' AND uploaded_image_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_uploaded_image_access(p_upload public.uploaded_images)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_places jsonb;
BEGIN
  IF p_upload.status = 'completed' THEN
    v_result := p_upload.ai_analysis #> '{upload_processing,result}';
    IF jsonb_typeof(v_result) IS DISTINCT FROM 'object' THEN
      -- Older completed uploads predate saved polling responses. Recover their
      -- persisted image/place data without re-running OCR, AI, or geocoding.
      SELECT COALESCE(jsonb_agg(to_jsonb(place) || jsonb_build_object(
        'place_id', place.id, 'confidence', link.confidence,
        'explanation', link.explanation, 'evidence_sources', link.evidence -> 'sources',
        'evidence_snippets', link.evidence -> 'snippets'
      ) ORDER BY link.created_at, link.id), '[]'::jsonb)
      INTO v_places
      FROM public.social_post_places link
      JOIN public.places place ON place.id = link.place_id
      WHERE link.uploaded_image_id = p_upload.id;
      v_result := jsonb_build_object(
        'success', true, 'status', 'completed', 'processing', false,
        'socialPostId', NULL, 'uploadedImageId', p_upload.id,
        'suggested_title', p_upload.ai_analysis #>> '{content,suggested_title}',
        'data', jsonb_build_object('id', p_upload.id, 'status', p_upload.status,
          'image_urls', p_upload.image_urls, 'caption', p_upload.caption),
        'places', v_places, 'place', v_places -> 0,
        'place_id', v_places #> '{0,id}',
        'placeIds', COALESCE((SELECT jsonb_agg(item -> 'id')
          FROM jsonb_array_elements(v_places) AS entries(item)), '[]'::jsonb),
        'aiAnalysis', p_upload.ai_analysis,
        'transcript', p_upload.ai_analysis #>> '{upload_processing,transcript}',
        'warnings', COALESCE(p_upload.ai_analysis #> '{upload_processing,warnings}', '[]'::jsonb)
      );
    END IF;
  END IF;
  INSERT INTO public.social_post_accesses (
    id, uploaded_image_id, social_post_id, user_id, canonical_source_key,
    source_url, platform, event, status, attempt_count, max_attempts,
    run_after, locked_at, locked_by, last_error, result, created_at, updated_at
  ) VALUES (
    p_upload.id, p_upload.id, NULL, p_upload.user_id, 'upload:' || p_upload.id::text,
    COALESCE(p_upload.image_urls[1], ''), 'upload', 'job',
    CASE WHEN p_upload.status = 'pending' THEN 'processing' ELSE p_upload.status END,
    1, 1, p_upload.created_at, NULL, NULL,
    CASE WHEN p_upload.status = 'failed' THEN p_upload.error_message ELSE NULL END,
    v_result,
    p_upload.created_at, p_upload.updated_at
  )
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    source_url = EXCLUDED.source_url,
    status = EXCLUDED.status,
    attempt_count = EXCLUDED.attempt_count,
    max_attempts = EXCLUDED.max_attempts,
    locked_at = NULL,
    locked_by = NULL,
    last_error = EXCLUDED.last_error,
    result = EXCLUDED.result,
    updated_at = EXCLUDED.updated_at
  WHERE social_post_accesses.uploaded_image_id = EXCLUDED.uploaded_image_id
    AND social_post_accesses.event = 'job';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Image ID % conflicts with an existing access record', p_upload.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_uploaded_image_access_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_uploaded_image_access(NEW);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_uploaded_image_access(public.uploaded_images) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_uploaded_image_access_trigger() FROM PUBLIC, anon, authenticated;
-- Only trigger execution and the migration owner need these functions.
DROP TRIGGER IF EXISTS uploaded_image_access_sync ON public.uploaded_images;
CREATE TRIGGER uploaded_image_access_sync
  AFTER INSERT OR UPDATE OF status, ai_analysis, error_message, image_urls, user_id, updated_at
  ON public.uploaded_images FOR EACH ROW
  EXECUTE FUNCTION public.sync_uploaded_image_access_trigger();

-- Include all existing uploads without changing their IDs or re-running AI.
SELECT public.sync_uploaded_image_access(upload) FROM public.uploaded_images upload;

-- Images run in process-url's after() callback, never in the URL worker.
CREATE OR REPLACE FUNCTION public.claim_url_processing_jobs(
  p_worker_id text, p_limit integer DEFAULT 2
)
RETURNS SETOF public.social_post_accesses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF nullif(trim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  UPDATE public.social_post_accesses
  SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
      run_after = now(), locked_at = NULL, locked_by = NULL,
      last_error = COALESCE(last_error, 'Worker lock expired before completion.'), updated_at = now()
  WHERE event = 'job' AND status = 'processing'
    AND uploaded_image_id IS NULL
    AND locked_at < now() - interval '10 minutes';
  RETURN QUERY
  WITH next_jobs AS (
    SELECT id FROM public.social_post_accesses
    WHERE event = 'job' AND status = 'queued' AND uploaded_image_id IS NULL
      AND run_after <= now() AND attempt_count < max_attempts
    ORDER BY created_at ASC FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2), 1), 3)
  ), claimed AS (
    UPDATE public.social_post_accesses access
    SET status = 'processing', attempt_count = access.attempt_count + 1,
        locked_at = now(), locked_by = p_worker_id, updated_at = now()
    FROM next_jobs WHERE access.id = next_jobs.id RETURNING access.*
  ) SELECT * FROM claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_url_processing_jobs(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_url_processing_jobs(text, integer) TO service_role;

-- Existing RLS stays enabled: image job data is exposed only by owner-checked APIs.
ALTER TABLE public.social_post_accesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploaded_images ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
COMMIT;
