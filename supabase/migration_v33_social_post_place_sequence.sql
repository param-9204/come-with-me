-- Persist the order in which a verified place first appears in a social post.
-- These attributes belong to the post-place link, not the reusable place row.

ALTER TABLE public.social_post_places
  ADD COLUMN IF NOT EXISTS sequence_position integer,
  ADD COLUMN IF NOT EXISTS first_frame_index integer,
  ADD COLUMN IF NOT EXISTS first_seen_at_seconds numeric;

ALTER TABLE public.social_post_places
  DROP CONSTRAINT IF EXISTS social_post_places_sequence_position_positive;
ALTER TABLE public.social_post_places
  ADD CONSTRAINT social_post_places_sequence_position_positive
  CHECK (sequence_position IS NULL OR sequence_position > 0);

ALTER TABLE public.social_post_places
  DROP CONSTRAINT IF EXISTS social_post_places_first_frame_index_nonnegative;
ALTER TABLE public.social_post_places
  ADD CONSTRAINT social_post_places_first_frame_index_nonnegative
  CHECK (first_frame_index IS NULL OR first_frame_index >= 0);

ALTER TABLE public.social_post_places
  DROP CONSTRAINT IF EXISTS social_post_places_first_seen_at_seconds_nonnegative;
ALTER TABLE public.social_post_places
  ADD CONSTRAINT social_post_places_first_seen_at_seconds_nonnegative
  CHECK (first_seen_at_seconds IS NULL OR first_seen_at_seconds >= 0);

-- Preserve sequence data written by the earlier JSON-evidence response field,
-- without changing any post that has no visual evidence.
UPDATE public.social_post_places
SET
  first_frame_index = CASE
    WHEN jsonb_typeof(evidence #> '{frame_evidence,frame_indexes}') = 'array'
      AND COALESCE(evidence #>> '{frame_evidence,frame_indexes,0}', '') ~ '^\d+$'
      THEN (evidence #>> '{frame_evidence,frame_indexes,0}')::integer
    ELSE first_frame_index
  END,
  first_seen_at_seconds = CASE
    WHEN jsonb_typeof(evidence #> '{frame_evidence,timestamps_seconds}') = 'array'
      AND COALESCE(evidence #>> '{frame_evidence,timestamps_seconds,0}', '') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (evidence #>> '{frame_evidence,timestamps_seconds,0}')::numeric
    ELSE first_seen_at_seconds
  END
WHERE first_frame_index IS NULL OR first_seen_at_seconds IS NULL;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY social_post_id
      ORDER BY first_seen_at_seconds NULLS LAST, first_frame_index, created_at, id
    )::integer AS position
  FROM public.social_post_places
  WHERE sequence_position IS NULL
    AND first_frame_index IS NOT NULL
)
UPDATE public.social_post_places link
SET sequence_position = ranked.position
FROM ranked
WHERE link.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_social_post_places_sequence
  ON public.social_post_places (social_post_id, sequence_position)
  WHERE sequence_position IS NOT NULL;

NOTIFY pgrst, 'reload schema';
