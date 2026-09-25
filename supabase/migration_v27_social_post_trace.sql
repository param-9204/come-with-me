-- Give every durable extraction-audit row a direct social-post key and expose
-- a one-query JSON trace for support/debugging. Run this after migration v26.

BEGIN;

-- Older deployments predate the legacy direct place-to-post column. Keep it
-- available in the trace alongside the social_post_places junction rows.
ALTER TABLE public.places
  ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL;

ALTER TABLE public.extraction_run_events
  ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_stage_runs
  ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_evidence
  ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_place_candidates
  ADD COLUMN IF NOT EXISTS social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL;

-- Preserve traceability for audit records created before this migration.
UPDATE public.extraction_run_events child
SET social_post_id = run.social_post_id
FROM public.extraction_runs run
WHERE child.run_id = run.id
  AND child.social_post_id IS NULL
  AND run.social_post_id IS NOT NULL;

UPDATE public.extraction_stage_runs child
SET social_post_id = run.social_post_id
FROM public.extraction_runs run
WHERE child.run_id = run.id
  AND child.social_post_id IS NULL
  AND run.social_post_id IS NOT NULL;

UPDATE public.extraction_evidence child
SET social_post_id = run.social_post_id
FROM public.extraction_runs run
WHERE child.run_id = run.id
  AND child.social_post_id IS NULL
  AND run.social_post_id IS NOT NULL;

UPDATE public.extraction_place_candidates child
SET social_post_id = run.social_post_id
FROM public.extraction_runs run
WHERE child.run_id = run.id
  AND child.social_post_id IS NULL
  AND run.social_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_extraction_events_social_post
  ON public.extraction_run_events(social_post_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_extraction_stages_social_post
  ON public.extraction_stage_runs(social_post_id, started_at);
CREATE INDEX IF NOT EXISTS idx_extraction_evidence_social_post
  ON public.extraction_evidence(social_post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_social_post
  ON public.extraction_place_candidates(social_post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_places_social_post_id
  ON public.places(social_post_id);

-- Run in the Supabase SQL editor with:
--   SELECT public.get_social_post_trace('YOUR_SHORT_CODE');
-- The result includes the raw post row, every place link, all candidates
-- (accepted/rejected/unresolved/save_failed), evidence, model operations,
-- events, run summaries, and recorded errors.
CREATE OR REPLACE FUNCTION public.get_social_post_trace(p_short_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'short_code', p_short_code,
    'posts', COALESCE(jsonb_agg(
      jsonb_build_object(
        'social_post_id', post.id,
        'social_post', to_jsonb(post),
        'place_links', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'social_post_place', to_jsonb(link),
              'place', to_jsonb(place)
            )
            ORDER BY link.created_at
          )
          FROM public.social_post_places link
          LEFT JOIN public.places place ON place.id = link.place_id
          WHERE link.social_post_id = post.id
        ), '[]'::jsonb),
        'legacy_places', COALESCE((
          SELECT jsonb_agg(to_jsonb(place) ORDER BY place.created_at)
          FROM public.places place
          WHERE place.social_post_id = post.id
        ), '[]'::jsonb),
        'diagnostics', jsonb_build_object(
          'post_error_message', post.error_message,
          'run_errors', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'run_id', run.id,
              'status', run.status,
              'error_code', run.error_code,
              'error_message', run.error_message
            ) ORDER BY run.created_at)
            FROM public.extraction_runs run
            WHERE run.social_post_id = post.id
              AND (run.error_code IS NOT NULL OR run.error_message IS NOT NULL OR run.status IN ('failed', 'partial'))
          ), '[]'::jsonb),
          'failed_or_partial_stage_runs', COALESCE((
            SELECT jsonb_agg(to_jsonb(stage) ORDER BY stage.started_at)
            FROM public.extraction_stage_runs stage
            JOIN public.extraction_runs run ON run.id = stage.run_id
            WHERE run.social_post_id = post.id
              AND stage.status IN ('failed', 'partial')
          ), '[]'::jsonb),
          'error_events', COALESCE((
            SELECT jsonb_agg(to_jsonb(event) ORDER BY event.occurred_at)
            FROM public.extraction_run_events event
            JOIN public.extraction_runs run ON run.id = event.run_id
            WHERE run.social_post_id = post.id
              AND event.level = 'error'
          ), '[]'::jsonb),
          'non_accepted_candidates', COALESCE((
            SELECT jsonb_agg(to_jsonb(candidate) ORDER BY candidate.created_at)
            FROM public.extraction_place_candidates candidate
            JOIN public.extraction_runs run ON run.id = candidate.run_id
            WHERE run.social_post_id = post.id
              AND candidate.decision <> 'accepted'
          ), '[]'::jsonb)
        ),
        'extraction', jsonb_build_object(
          'runs', COALESCE((
            SELECT jsonb_agg(to_jsonb(run) ORDER BY run.created_at)
            FROM public.extraction_runs run
            WHERE run.social_post_id = post.id
          ), '[]'::jsonb),
          'run_summaries', COALESCE((
            SELECT jsonb_agg(to_jsonb(summary) ORDER BY summary.created_at)
            FROM public.extraction_run_summary summary
            WHERE summary.social_post_id = post.id
          ), '[]'::jsonb),
          'events', COALESCE((
            SELECT jsonb_agg(to_jsonb(event) ORDER BY event.occurred_at)
            FROM public.extraction_run_events event
            JOIN public.extraction_runs run ON run.id = event.run_id
            WHERE run.social_post_id = post.id
          ), '[]'::jsonb),
          'stage_runs', COALESCE((
            SELECT jsonb_agg(to_jsonb(stage) ORDER BY stage.started_at)
            FROM public.extraction_stage_runs stage
            JOIN public.extraction_runs run ON run.id = stage.run_id
            WHERE run.social_post_id = post.id
          ), '[]'::jsonb),
          'evidence', COALESCE((
            SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence.created_at)
            FROM public.extraction_evidence evidence
            JOIN public.extraction_runs run ON run.id = evidence.run_id
            WHERE run.social_post_id = post.id
          ), '[]'::jsonb),
          'place_candidates', COALESCE((
            SELECT jsonb_agg(to_jsonb(candidate) ORDER BY candidate.created_at)
            FROM public.extraction_place_candidates candidate
            JOIN public.extraction_runs run ON run.id = candidate.run_id
            WHERE run.social_post_id = post.id
          ), '[]'::jsonb)
        )
      )
      ORDER BY post.created_at DESC
    ), '[]'::jsonb)
  )
  FROM public.social_posts post
  WHERE post.short_code = NULLIF(btrim(p_short_code), '');
$$;

REVOKE ALL ON FUNCTION public.get_social_post_trace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_social_post_trace(text) TO service_role;

COMMIT;
