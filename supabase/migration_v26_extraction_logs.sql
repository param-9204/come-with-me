-- ── Migration v26: Extraction pipeline logging ──
-- Queryable record of every place-extraction run: stages, metered calls
-- (tokens, audio seconds, requests, estimated cost), candidate outcomes, and
-- the raw event stream for debugging.
--
-- Raw post content (caption, OCR frames, transcript, Apify payload) is NOT
-- copied here: it already lives on social_posts and is referenced by id.
--
-- The application detects these tables at runtime and keeps working (JSONL
-- logs only) until this migration is applied.
--
-- Access: RLS is enabled with no policies, so only the service role can read
-- or write. Views use security_invoker (PostgreSQL 15+) so they do not bypass
-- that through the API.

-- 1. RUNS: one row per pipeline attempt for a post ─────────────────────────
CREATE TABLE IF NOT EXISTS public.extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  platform text,                         -- instagram | tiktok
  content_type text,                     -- post | reel | video
  content_id text,
  input_url text NOT NULL,               -- query string removed
  route text NOT NULL,                   -- stream | process-url | analyze | media
  trigger text NOT NULL DEFAULT 'new',   -- new | retry | legacy_recovery | cached_restricted_recovery | cache_hit
  status text NOT NULL DEFAULT 'running',-- running | completed | partial | failed | cache_hit
  failed_stage text,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,

  -- Input signals (counts only)
  caption_chars integer,
  hashtag_count integer,
  mention_count integer,
  tagged_account_count integer,
  has_location_tag boolean,
  comment_count integer,
  creator_comment_count integer,
  media_items integer,
  video_duration_sec numeric(8, 2),
  subtitle_tracks integer,
  is_restricted boolean,

  -- Evidence seen by the model
  evidence_items integer,
  evidence_by_source jsonb,              -- {"caption":3,"ocr":14,"speech":6,...}
  evidence_availability jsonb,
  transcript_source text,                -- platform-subtitles | whisper | none
  transcript_language text,
  ocr_frames integer,
  vision_frames integer,

  -- Outcome
  candidates_count integer,              -- raw model candidates, all passes
  rejected_count integer,
  accepted_count integer,                -- after scoring and merging
  saved_count integer,                   -- linked to a place row
  unsaved_count integer,                 -- accepted but not persisted
  recovery_pass boolean DEFAULT false,
  recovery_places_added integer,

  pipeline_version text,                 -- deploy commit sha when available
  config jsonb,                          -- OCR order, models (never keys)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_post ON public.extraction_runs (social_post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_created ON public.extraction_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_status ON public.extraction_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_platform ON public.extraction_runs (platform, created_at DESC);

-- 2. STAGES: one row per stage execution ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.extraction_run_stages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  stage text NOT NULL,          -- scrape | media_download | frames | transcript | ocr | vision_ocr | extraction | recovery | save_places | persist_post
  provider text,                -- apify | ffmpeg | paddle | tesseract | glm | google | gpt | whisper | platform-subtitles ...
  status text NOT NULL,         -- success | partial | skipped | failed
  started_at timestamptz NOT NULL,
  duration_ms integer,
  items_in integer,
  items_out integer,
  error_message text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_run_stages_run ON public.extraction_run_stages (run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_run_stages_stage ON public.extraction_run_stages (stage, provider, created_at DESC);

-- 3. CALLS: one row per metered external call attempt ───────────────────────
CREATE TABLE IF NOT EXISTS public.extraction_run_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  operation text NOT NULL,      -- place_extraction | place_recovery | vision_ocr | transcription | places_text_search | geocode | reverse_geocode | mapbox_search | mapbox_geocode | cloud_vision | scrape
  provider text NOT NULL,       -- openai | groq | zai | google | mapbox | apify
  model text,
  status text NOT NULL,         -- success | error
  attempt smallint NOT NULL DEFAULT 1,   -- position in the provider fallback chain, or retry number
  is_fallback boolean NOT NULL DEFAULT false,
  http_status integer,
  error_message text,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  cached_input_tokens integer,
  reasoning_tokens integer,
  audio_seconds numeric(10, 2),
  images integer,
  request_units integer NOT NULL DEFAULT 1,
  est_cost_usd numeric(12, 6),  -- NULL = no price known for this provider/model
  cost_source text,             -- price_table | provider_reported | free
  latency_ms integer,
  finish_reason text,
  prompt_hash text,             -- short hash of the system prompt, to compare prompt versions
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_run_calls_run ON public.extraction_run_calls (run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_run_calls_created ON public.extraction_run_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_run_calls_provider ON public.extraction_run_calls (provider, model, operation, created_at DESC);

-- 4. CANDIDATES: one row per candidate outcome ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.extraction_candidates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
  pass text NOT NULL,           -- primary | recovery | restricted_recovery
  decision text NOT NULL,       -- rejected | saved | linked_existing | unsaved | save_error
  reason_code text,             -- slug for rejected / unsaved, e.g. name_not_found_in_evidence
  reason text,
  name text,
  search_query text,            -- indirect mentions
  mention_type text,            -- explicit | handle | indirect
  model_role text,              -- featured | recommended | mentioned_only | background
  base_category text,
  category text,                -- as extracted
  saved_category text,          -- after the Google type check
  city text,
  neighborhood text,
  address text,
  confidence numeric(4, 3),
  evidence_ids text[],
  location_evidence_ids text[],
  evidence_sources text[],
  evidence_snippets jsonb,
  place_id uuid REFERENCES public.places(id) ON DELETE SET NULL,
  geocode_provider text,        -- google | mapbox | stored
  geocode_verified boolean,
  geocode_ambiguous boolean,
  google_place_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_candidates_run ON public.extraction_candidates (run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_decision ON public.extraction_candidates (decision, reason_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_place ON public.extraction_candidates (place_id) WHERE place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_post ON public.extraction_candidates (social_post_id) WHERE social_post_id IS NOT NULL;

-- 5. RAW LOGS: event stream + evidence snapshot per flush (short retention) ──
CREATE TABLE IF NOT EXISTS public.extraction_run_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.extraction_runs(id) ON DELETE CASCADE,
  part text NOT NULL,           -- pipeline | media | analysis
  event_count integer NOT NULL DEFAULT 0,
  warn_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  events jsonb NOT NULL,
  evidence jsonb,               -- [{id, source, text (trimmed), t}] exactly as sent to the model
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_run_logs_run ON public.extraction_run_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_run_logs_created ON public.extraction_run_logs (created_at);

-- 6. ACCESS ────────────────────────────────────────────────────────────────
ALTER TABLE public.extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_run_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_run_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_run_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extraction_runs, public.extraction_run_stages, public.extraction_run_calls,
  public.extraction_candidates, public.extraction_run_logs FROM anon, authenticated;

-- 7. ANALYTICS VIEWS ────────────────────────────────────────────────────────

-- Cost and tokens per run.
CREATE OR REPLACE VIEW public.extraction_run_costs WITH (security_invoker = on) AS
SELECT
  r.id AS run_id,
  r.social_post_id,
  r.platform,
  r.status,
  r.trigger,
  r.created_at,
  r.saved_count,
  count(c.id) AS calls,
  count(c.id) FILTER (WHERE c.status = 'error') AS failed_calls,
  count(c.id) FILTER (WHERE c.is_fallback) AS fallback_calls,
  coalesce(sum(c.input_tokens), 0) AS input_tokens,
  coalesce(sum(c.output_tokens), 0) AS output_tokens,
  coalesce(sum(c.total_tokens), 0) AS total_tokens,
  coalesce(sum(c.cached_input_tokens), 0) AS cached_input_tokens,
  coalesce(sum(c.audio_seconds), 0) AS audio_seconds,
  coalesce(sum(c.est_cost_usd), 0) AS est_cost_usd,
  count(c.id) FILTER (WHERE c.est_cost_usd IS NULL AND c.status = 'success') AS unpriced_calls,
  CASE WHEN coalesce(r.saved_count, 0) > 0
    THEN coalesce(sum(c.est_cost_usd), 0) / r.saved_count END AS est_cost_per_saved_place
FROM public.extraction_runs r
LEFT JOIN public.extraction_run_calls c ON c.run_id = r.id
GROUP BY r.id;

-- Daily spend by provider / model / operation.
CREATE OR REPLACE VIEW public.extraction_daily_costs WITH (security_invoker = on) AS
SELECT
  date_trunc('day', created_at) AS day,
  provider,
  model,
  operation,
  count(*) AS calls,
  count(*) FILTER (WHERE status = 'error') AS errors,
  count(*) FILTER (WHERE is_fallback) AS fallbacks,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(cached_input_tokens) AS cached_input_tokens,
  sum(audio_seconds) AS audio_seconds,
  sum(images) AS images,
  sum(est_cost_usd) AS est_cost_usd,
  count(*) FILTER (WHERE est_cost_usd IS NULL AND status = 'success') AS unpriced_calls,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
FROM public.extraction_run_calls
GROUP BY 1, 2, 3, 4;

-- Why candidates are dropped (false-negative analysis).
CREATE OR REPLACE VIEW public.extraction_reject_reasons WITH (security_invoker = on) AS
SELECT
  date_trunc('day', c.created_at) AS day,
  r.platform,
  c.pass,
  c.decision,
  c.reason_code,
  count(*) AS candidates,
  count(DISTINCT c.run_id) AS runs
FROM public.extraction_candidates c
JOIN public.extraction_runs r ON r.id = c.run_id
WHERE c.decision IN ('rejected', 'unsaved', 'save_error')
GROUP BY 1, 2, 3, 4, 5;

-- Stage reliability and latency per provider.
CREATE OR REPLACE VIEW public.extraction_stage_health WITH (security_invoker = on) AS
SELECT
  date_trunc('day', created_at) AS day,
  stage,
  provider,
  count(*) AS executions,
  count(*) FILTER (WHERE status = 'success') AS succeeded,
  count(*) FILTER (WHERE status = 'partial') AS partial,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  count(*) FILTER (WHERE status = 'skipped') AS skipped,
  sum(items_in) AS items_in,
  sum(items_out) AS items_out,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM public.extraction_run_stages
GROUP BY 1, 2, 3;

-- Runs that probably missed places: signals were present but nothing was saved,
-- or accepted places could not be persisted. Also surfaces runs stuck in
-- "running" (process killed or timed out before it could log a result).
CREATE OR REPLACE VIEW public.extraction_suspect_runs WITH (security_invoker = on) AS
SELECT
  r.*,
  CASE
    WHEN r.status = 'running' AND r.started_at < now() - interval '10 minutes' THEN 'abandoned'
    WHEN r.status IN ('completed', 'partial') AND coalesce(r.saved_count, 0) = 0
      AND (r.has_location_tag OR coalesce(r.tagged_account_count, 0) > 0) THEN 'signals_but_nothing_saved'
    WHEN coalesce(r.unsaved_count, 0) > 0 THEN 'accepted_but_unsaved'
    WHEN r.status IN ('completed', 'partial') AND coalesce(r.evidence_items, 0) = 0 THEN 'no_evidence'
  END AS suspicion
FROM public.extraction_runs r
WHERE (r.status = 'running' AND r.started_at < now() - interval '10 minutes')
   OR (r.status IN ('completed', 'partial') AND coalesce(r.saved_count, 0) = 0
       AND (r.has_location_tag OR coalesce(r.tagged_account_count, 0) > 0))
   OR coalesce(r.unsaved_count, 0) > 0
   OR (r.status IN ('completed', 'partial') AND coalesce(r.evidence_items, 0) = 0);

REVOKE ALL ON public.extraction_run_costs, public.extraction_daily_costs, public.extraction_reject_reasons,
  public.extraction_stage_health, public.extraction_suspect_runs FROM anon, authenticated;

-- 8. RETENTION ─────────────────────────────────────────────────────────────
-- Raw event logs are bulky: keep them 30 days (the same as the JSONL files).
-- Structured rows are small: keep them 180 days for trend and cost analysis.
-- Schedule with pg_cron, e.g.:
--   SELECT cron.schedule('prune-extraction-logs', '17 3 * * *', 'SELECT public.prune_extraction_logs()');
CREATE OR REPLACE FUNCTION public.prune_extraction_logs(raw_days integer DEFAULT 30, summary_days integer DEFAULT 180)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM public.extraction_run_logs WHERE created_at < now() - make_interval(days => raw_days);
  DELETE FROM public.extraction_runs WHERE created_at < now() - make_interval(days => summary_days);
$$;
REVOKE ALL ON FUNCTION public.prune_extraction_logs(integer, integer) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Example queries ───────────────────────────────────────────────────────
--
-- Spend by provider/model over the last 7 days (unpriced_calls > 0 means a
-- price is missing: add it to PRICING_OVERRIDES_JSON):
--   SELECT provider, model, operation, sum(calls) calls, sum(est_cost_usd) usd, sum(unpriced_calls) unpriced
--   FROM extraction_daily_costs WHERE day > now() - interval '7 days'
--   GROUP BY 1, 2, 3 ORDER BY usd DESC NULLS LAST;
--
-- Is the recovery pass worth its tokens? (places it added vs what it cost)
--   SELECT count(*) runs, sum(r.recovery_places_added) places_added,
--          sum((SELECT sum(c.est_cost_usd) FROM extraction_run_calls c
--               WHERE c.run_id = r.id AND c.operation = 'place_recovery')) usd
--   FROM extraction_runs r WHERE r.recovery_pass;
--
-- Is OpenAI prompt caching kicking in on the extraction prompt?
--   SELECT prompt_hash, sum(cached_input_tokens)::float / nullif(sum(input_tokens), 0) cached_share
--   FROM extraction_run_calls WHERE operation = 'place_extraction' GROUP BY 1;
--
-- Top reasons candidates are dropped (likely misses):
--   SELECT decision, reason_code, sum(candidates) n FROM extraction_reject_reasons
--   WHERE day > now() - interval '30 days' GROUP BY 1, 2 ORDER BY n DESC;
--
-- OCR engines: how many frames each reads, and how often it fails:
--   SELECT stage, provider, sum(items_in) frames_in, sum(items_out) frames_read, sum(failed) failed_runs, max(p95_ms) p95_ms
--   FROM extraction_stage_health GROUP BY 1, 2 ORDER BY 1, 2;
--
-- Everything about one post's latest run:
--   SELECT * FROM extraction_runs WHERE social_post_id = '<id>' ORDER BY created_at DESC LIMIT 1;
--   SELECT * FROM extraction_candidates WHERE run_id = '<run id>' ORDER BY decision;
--   SELECT evidence FROM extraction_run_logs WHERE run_id = '<run id>' AND evidence IS NOT NULL;
--
-- Same URL processed concurrently (duplicate spend):
--   SELECT a.social_post_id, a.id, b.id FROM extraction_runs a JOIN extraction_runs b
--     ON a.social_post_id = b.social_post_id AND a.id < b.id
--    AND b.started_at < coalesce(a.finished_at, a.started_at + interval '5 minutes')
--   WHERE a.trigger <> 'cache_hit' AND b.trigger <> 'cache_hit';
