-- Production extraction-pipeline audit log.
-- This is append-only operational data. It intentionally does not store media,
-- raw provider responses, API keys, or base64 image/audio payloads.

CREATE TABLE IF NOT EXISTS public.extraction_runs (
  id uuid PRIMARY KEY,
  external_run_id text,
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
  platform text,
  input_url text,
  entrypoint text,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.extraction_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  elapsed_ms integer NOT NULL DEFAULT 0,
  stage text NOT NULL,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.extraction_stage_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'skipped')),
  provider text,
  model text,
  attempt smallint NOT NULL DEFAULT 1 CHECK (attempt > 0),
  is_fallback boolean NOT NULL DEFAULT false,
  retry_of_id bigint REFERENCES public.extraction_stage_runs(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  input_units numeric(14,3),
  output_units numeric(14,3),
  estimated_cost_usd numeric(14,8),
  cost_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  retryable boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.extraction_evidence (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  source_type text NOT NULL,
  text_value text NOT NULL,
  text_sha256 text NOT NULL,
  confidence numeric(5,4),
  timestamps_sec numeric[] NOT NULL DEFAULT '{}',
  frame_indexes integer[] NOT NULL DEFAULT '{}',
  provider text,
  model text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS public.extraction_place_candidates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  candidate_key text NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE SET NULL,
  name text,
  category text,
  base_category text,
  city text,
  neighborhood text,
  address text,
  confidence numeric(5,4),
  mention_type text,
  role text,
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected', 'unresolved', 'save_failed')),
  decision_reason text,
  evidence_ids text[] NOT NULL DEFAULT '{}',
  location_evidence_ids text[] NOT NULL DEFAULT '{}',
  evidence_sources text[] NOT NULL DEFAULT '{}',
  model_provider text,
  model text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, candidate_key)
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_created_at ON public.extraction_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_platform_url ON public.extraction_runs(platform, input_url);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_social_post ON public.extraction_runs(social_post_id);
CREATE INDEX IF NOT EXISTS idx_extraction_events_run_time ON public.extraction_run_events(run_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_extraction_stages_run_time ON public.extraction_stage_runs(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_extraction_stages_failure ON public.extraction_stage_runs(stage, status) WHERE status <> 'success';
CREATE INDEX IF NOT EXISTS idx_extraction_evidence_run_source ON public.extraction_evidence(run_id, source_type);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_run_decision ON public.extraction_place_candidates(run_id, decision);

-- Queryable per-run cost and quality rollup. The base tables remain available
-- for individual OCR frames, retries, rejected candidates, and raw evidence.
CREATE OR REPLACE VIEW public.extraction_run_summary AS
SELECT
  r.*,
  COALESCE(cost.operation_count, 0) AS operation_count,
  COALESCE(cost.total_input_tokens, 0) AS total_input_tokens,
  COALESCE(cost.total_output_tokens, 0) AS total_output_tokens,
  COALESCE(cost.total_tokens, 0) AS total_tokens,
  COALESCE(cost.estimated_cost_usd, 0) AS estimated_cost_usd,
  COALESCE(candidate.accepted_count, 0) AS accepted_candidate_count,
  COALESCE(candidate.rejected_count, 0) AS rejected_candidate_count,
  COALESCE(candidate.unresolved_count, 0) AS unresolved_candidate_count,
  COALESCE(candidate.save_failed_count, 0) AS save_failed_candidate_count
FROM public.extraction_runs r
LEFT JOIN LATERAL (
  SELECT
    count(*) AS operation_count,
    sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens,
    sum(total_tokens) AS total_tokens,
    sum(estimated_cost_usd) AS estimated_cost_usd
  FROM public.extraction_stage_runs s
  WHERE s.run_id = r.id
) cost ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE decision = 'accepted') AS accepted_count,
    count(*) FILTER (WHERE decision = 'rejected') AS rejected_count,
    count(*) FILTER (WHERE decision = 'unresolved') AS unresolved_count,
    count(*) FILTER (WHERE decision = 'save_failed') AS save_failed_count
  FROM public.extraction_place_candidates c
  WHERE c.run_id = r.id
) candidate ON true;

-- Call from a scheduled Supabase job (for example nightly) to bound log
-- growth. Child audit records are removed through foreign-key cascades.
CREATE OR REPLACE FUNCTION public.purge_extraction_audit_logs(
  keep_for interval DEFAULT interval '90 days'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE deleted_count bigint;
BEGIN
  DELETE FROM public.extraction_runs
  WHERE created_at < now() - keep_for;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_extraction_audit_logs(interval) FROM PUBLIC;

ALTER TABLE public.extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_stage_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_place_candidates ENABLE ROW LEVEL SECURITY;

-- No browser-facing policies: only the server-side Supabase service role writes
-- operational logs. Grant read access through an authenticated admin endpoint,
-- never directly from the mobile client.
