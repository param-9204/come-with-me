-- Let the existing extraction audit trail describe direct image uploads too.
-- Exactly one source is present: social_post_id for URL processing, or
-- uploaded_image_id for direct image processing.

ALTER TABLE public.extraction_runs
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_run_events
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_stage_runs
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_evidence
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE SET NULL;
ALTER TABLE public.extraction_place_candidates
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_extraction_runs_uploaded_image
  ON public.extraction_runs(uploaded_image_id, started_at DESC)
  WHERE uploaded_image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_events_uploaded_image
  ON public.extraction_run_events(uploaded_image_id, occurred_at)
  WHERE uploaded_image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_stages_uploaded_image
  ON public.extraction_stage_runs(uploaded_image_id, started_at)
  WHERE uploaded_image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_evidence_uploaded_image
  ON public.extraction_evidence(uploaded_image_id, created_at)
  WHERE uploaded_image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_uploaded_image
  ON public.extraction_place_candidates(uploaded_image_id, created_at)
  WHERE uploaded_image_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
