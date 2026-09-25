-- ── COMPLETE DATABASE SCHEMA FOR COME WITH ME 🗺️ ──
-- Paste and execute this consolidated script inside your Supabase SQL Editor.
-- Safe to execute on existing databases: does NOT drop any tables or delete data.

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. PROFILES TABLE (strictly like Image 2)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  phone text,
  created_at timestamptz DEFAULT now()
);


-- 3. PLACES TABLE
CREATE TABLE IF NOT EXISTS public.places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  neighborhood text,
  city text DEFAULT 'New York',
  category text,
  description text,
  creator_handle text,
  source text, -- tiktok | instagram | discovery
  latitude double precision,
  longitude double precision,
  source_url text,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  audio_transcript text,
  social_post_id uuid, -- Foreign key constraint ensured safely below
  created_at timestamptz DEFAULT now()
);

-- 4. SOCIAL POSTS TABLE
CREATE TABLE IF NOT EXISTS public.social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id uuid REFERENCES public.places(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  platform text NOT NULL, -- 'tiktok', 'instagram'
  content_type text, -- 'video', 'reel', 'post'
  content_id text NOT NULL, -- The original post ID
  author_username text,
  caption text,
  video_url text,
  likes integer DEFAULT 0,
  views integer DEFAULT 0,
  comments integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  -- Full intelligence pipeline analysis columns
  raw_apify_data jsonb,
  ai_analysis jsonb,
  ocr_frames_apify jsonb,
  ocr_frames_gpt jsonb,
  whisper_transcript text,
  video_plays integer,
  video_duration integer,
  dimensions_width integer,
  dimensions_height integer,
  hashtags text[],
  mentions text[],
  tagged_users jsonb,
  music_info jsonb,
  mentioned_brands text[],
  mentioned_locations text[],
  primary_category text,
  secondary_categories text[],
  content_summary text,
  is_promotional boolean,
  is_paid_partnership boolean,
  owner_full_name text,
  short_code text,
  product_type text,
  engagement_rate numeric(8,4),
  ocr_combined_text text,
  display_url text,
  first_comment text,
  niche text,
  target_audience text,
  call_to_actions text[],
  post_url text,
  canonical_source_key text,
  merged_into_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
  status text DEFAULT 'pending',
  error_message text,
  UNIQUE(platform, content_id),
  UNIQUE(platform, canonical_source_key)
);

-- One row per user URL submission. The shared post remains in social_posts.
CREATE TABLE IF NOT EXISTS public.social_post_accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  canonical_source_key text NOT NULL,
  source_url text NOT NULL,
  platform text CHECK (platform IS NULL OR platform IN ('instagram', 'tiktok')),
  -- started/retry/joined/cache_hit are audit rows; job rows are mobile jobs.
  event text NOT NULL CHECK (event IN ('started', 'retry', 'joined_processing', 'cache_hit', 'job')),
  status text CHECK (status IS NULL OR status IN ('queued', 'processing', 'waiting', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    event <> 'job'
    OR (user_id IS NOT NULL AND platform IS NOT NULL AND status IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_post_time ON public.social_post_accesses (social_post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_user_time ON public.social_post_accesses (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_source_time ON public.social_post_accesses (canonical_source_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_ready_jobs
  ON public.social_post_accesses (run_after, created_at) WHERE event = 'job' AND status = 'queued';
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_job_user_time
  ON public.social_post_accesses (user_id, created_at DESC) WHERE event = 'job';
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_job_post
  ON public.social_post_accesses (social_post_id) WHERE event = 'job' AND social_post_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_url_processing_jobs(p_worker_id text, p_limit integer DEFAULT 2)
RETURNS SETOF public.social_post_accesses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF nullif(trim(p_worker_id), '') IS NULL THEN RAISE EXCEPTION 'worker id is required'; END IF;
  UPDATE public.social_post_accesses
  SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
      run_after = now(), locked_at = NULL, locked_by = NULL,
      last_error = COALESCE(last_error, 'Worker lock expired before completion.'), updated_at = now()
  WHERE event = 'job' AND status = 'processing' AND locked_at < now() - interval '10 minutes';
  RETURN QUERY
  WITH next_jobs AS (
    SELECT id FROM public.social_post_accesses
    WHERE event = 'job' AND status = 'queued' AND run_after <= now() AND attempt_count < max_attempts
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

-- Safely add foreign key from places to social_posts if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name='fk_places_social_post_id'
  ) THEN
    ALTER TABLE public.places
      ADD CONSTRAINT fk_places_social_post_id
      FOREIGN KEY (social_post_id)
      REFERENCES public.social_posts(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- 5. SAVED PLACES TABLE (strictly like Image 2)
CREATE TABLE IF NOT EXISTS public.saved_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, place_id)
);

-- 6. LISTS TABLE (strictly like Image 2)
CREATE TABLE IF NOT EXISTS public.lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL,
  description text,
  city text DEFAULT 'New York',
  cover_emoji text DEFAULT '📍',
  is_public boolean DEFAULT true,
  slug text,
  created_at timestamptz DEFAULT now()
);

-- 7. LIST PLACES JUNCTION TABLE (strictly like Image 2)
CREATE TABLE IF NOT EXISTS public.list_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES public.lists(id) ON DELETE CASCADE NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT NULL,
  position integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(list_id, place_id)
);

-- 8. LIST COLLABORATORS TABLE
CREATE TABLE IF NOT EXISTS public.list_collaborators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES public.lists(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  role text DEFAULT 'editor', -- editor | viewer
  created_at timestamptz DEFAULT now(),
  UNIQUE(list_id, user_id)
);

-- 9. GUIDES TABLE
CREATE TABLE IF NOT EXISTS public.guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  creator_name text,
  creator_handle text,
  title text NOT NULL,
  destination text,
  intro text,
  cover_image_url text,
  cover_emoji text,
  is_published boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 10. GUIDE PLACES TABLE
CREATE TABLE IF NOT EXISTS public.guide_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid REFERENCES public.guides(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  category text,
  neighborhood text,
  city text,
  description text,
  address text,
  google_maps_url text,
  image_url text,
  time_of_day text,
  latitude double precision,
  longitude double precision,
  position integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 11. FOLLOWS TABLE
CREATE TABLE IF NOT EXISTS public.follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  following_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(follower_id, following_id)
);

-- 12. WAITLIST TABLE
CREATE TABLE IF NOT EXISTS public.waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  city text,
  role text DEFAULT 'explorer', -- explorer | creator | brand
  phone text,
  created_at timestamptz DEFAULT now()
);

-- 13. CITIES TABLE
CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  latitude double precision,
  longitude double precision,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- 13b. SOCIAL POST PLACES JUNCTION TABLE (Many-to-Many linking)
CREATE TABLE IF NOT EXISTS public.social_post_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE CASCADE NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(social_post_id, place_id)
);

-- 13c. Multi-signal extraction (migration v25)
ALTER TABLE public.places ADD COLUMN IF NOT EXISTS google_place_id text;
CREATE UNIQUE INDEX IF NOT EXISTS places_google_place_id_unique
  ON public.places (google_place_id) WHERE google_place_id IS NOT NULL;
ALTER TABLE public.social_post_places ADD COLUMN IF NOT EXISTS confidence numeric(4, 3);
ALTER TABLE public.social_post_places ADD COLUMN IF NOT EXISTS explanation text;
ALTER TABLE public.social_post_places ADD COLUMN IF NOT EXISTS evidence jsonb;

-- 13d. EXTRACTION PIPELINE AUDIT LOGS (migration v26)
-- Durable, server-only logs. Raw media/base64 payloads and credentials are
-- intentionally excluded; source text is capped and redacted in application code.
CREATE TABLE IF NOT EXISTS public.extraction_runs (
  id uuid PRIMARY KEY,
  external_run_id text,
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
  platform text,
  input_url text,
  entrypoint text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
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
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
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
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
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
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
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
  social_post_id uuid REFERENCES public.social_posts(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_extraction_events_social_post ON public.extraction_run_events(social_post_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_extraction_stages_run_time ON public.extraction_stage_runs(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_extraction_stages_social_post ON public.extraction_stage_runs(social_post_id, started_at);
CREATE INDEX IF NOT EXISTS idx_extraction_stages_failure ON public.extraction_stage_runs(stage, status) WHERE status <> 'success';
CREATE INDEX IF NOT EXISTS idx_extraction_evidence_run_source ON public.extraction_evidence(run_id, source_type);
CREATE INDEX IF NOT EXISTS idx_extraction_evidence_social_post ON public.extraction_evidence(social_post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_run_decision ON public.extraction_place_candidates(run_id, decision);
CREATE INDEX IF NOT EXISTS idx_extraction_candidates_social_post ON public.extraction_place_candidates(social_post_id, created_at);

CREATE OR REPLACE VIEW public.extraction_run_summary AS
SELECT r.*,
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
  SELECT count(*) AS operation_count, sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens, sum(total_tokens) AS total_tokens,
    sum(estimated_cost_usd) AS estimated_cost_usd
  FROM public.extraction_stage_runs s WHERE s.run_id = r.id
) cost ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE decision = 'accepted') AS accepted_count,
    count(*) FILTER (WHERE decision = 'rejected') AS rejected_count,
    count(*) FILTER (WHERE decision = 'unresolved') AS unresolved_count,
    count(*) FILTER (WHERE decision = 'save_failed') AS save_failed_count
  FROM public.extraction_place_candidates c WHERE c.run_id = r.id
) candidate ON true;

CREATE OR REPLACE FUNCTION public.purge_extraction_audit_logs(keep_for interval DEFAULT interval '90 days')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE deleted_count bigint;
BEGIN
  DELETE FROM public.extraction_runs WHERE created_at < now() - keep_for;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_extraction_audit_logs(interval) FROM PUBLIC;

-- 14. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_post_accesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guide_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_post_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_stage_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_place_candidates ENABLE ROW LEVEL SECURITY;

-- 15. SECURITY POLICIES (Safe drop & create)

-- profiles policies
DROP POLICY IF EXISTS "Anyone can read profiles" ON public.profiles;
CREATE POLICY "Anyone can read profiles" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (id = auth.uid());

-- places policies
DROP POLICY IF EXISTS "Anyone can read places" ON public.places;
CREATE POLICY "Anyone can read places" ON public.places FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert places" ON public.places;
CREATE POLICY "Authenticated users can insert places" ON public.places FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- social_posts policies
DROP POLICY IF EXISTS "Anyone can read social posts" ON public.social_posts;
CREATE POLICY "Anyone can read social posts" ON public.social_posts FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert social posts" ON public.social_posts;
CREATE POLICY "Authenticated users can insert social posts" ON public.social_posts FOR INSERT WITH CHECK (auth.uid() IS NOT NULL OR true);

DROP POLICY IF EXISTS "Users can update their own posts" ON public.social_posts;
CREATE POLICY "Users can update their own posts" ON public.social_posts FOR UPDATE USING (auth.uid() = user_id);

-- saved_places policies
DROP POLICY IF EXISTS "Users can view their saved places" ON public.saved_places;
CREATE POLICY "Users can view their saved places" ON public.saved_places FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their saved places" ON public.saved_places;
CREATE POLICY "Users can insert their saved places" ON public.saved_places FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their saved places" ON public.saved_places;
CREATE POLICY "Users can delete their saved places" ON public.saved_places FOR DELETE USING (auth.uid() = user_id);

-- lists policies
DROP POLICY IF EXISTS "Users can view their own lists and shared lists" ON public.lists;
CREATE POLICY "Users can view their own lists and shared lists" ON public.lists FOR SELECT USING (
  user_id = auth.uid()
  OR id IN (SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid())
  OR is_public = true
);

DROP POLICY IF EXISTS "Users can create their own lists" ON public.lists;
CREATE POLICY "Users can create their own lists" ON public.lists FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners can update their lists" ON public.lists;
CREATE POLICY "Owners can update their lists" ON public.lists FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners can delete their lists" ON public.lists;
CREATE POLICY "Owners can delete their lists" ON public.lists FOR DELETE USING (user_id = auth.uid());

-- list_places policies
DROP POLICY IF EXISTS "Users can view places in accessible lists" ON public.list_places;
CREATE POLICY "Users can view places in accessible lists" ON public.list_places FOR SELECT USING (
  list_id IN (
    SELECT id FROM public.lists WHERE
      user_id = auth.uid()
      OR id IN (SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid())
      OR is_public = true
  )
);

DROP POLICY IF EXISTS "List owners and collaborators can add places" ON public.list_places;
CREATE POLICY "List owners and collaborators can add places" ON public.list_places FOR INSERT WITH CHECK (
  list_id IN (
    SELECT id FROM public.lists WHERE user_id = auth.uid()
    UNION
    SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid() AND role = 'editor'
  )
);

DROP POLICY IF EXISTS "List owners and collaborators can remove places" ON public.list_places;
CREATE POLICY "List owners and collaborators can remove places" ON public.list_places FOR DELETE USING (
  list_id IN (
    SELECT id FROM public.lists WHERE user_id = auth.uid()
    UNION
    SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid() AND role = 'editor'
  )
);

-- list_collaborators policies
DROP POLICY IF EXISTS "Users can view list collaborators" ON public.list_collaborators;
CREATE POLICY "Users can view list collaborators" ON public.list_collaborators FOR SELECT USING (
  list_id IN (SELECT id FROM public.lists WHERE user_id = auth.uid())
  OR user_id = auth.uid()
);

DROP POLICY IF EXISTS "Owners can invite collaborators" ON public.list_collaborators;
CREATE POLICY "Owners can invite collaborators" ON public.list_collaborators FOR INSERT WITH CHECK (
  list_id IN (SELECT id FROM public.lists WHERE user_id = auth.uid())
);

DROP POLICY IF EXISTS "Owners can remove collaborators" ON public.list_collaborators;
CREATE POLICY "Owners can remove collaborators" ON public.list_collaborators FOR DELETE USING (
  list_id IN (SELECT id FROM public.lists WHERE user_id = auth.uid())
);

-- guides policies
DROP POLICY IF EXISTS "Anyone can view published guides" ON public.guides;
CREATE POLICY "Anyone can view published guides" ON public.guides FOR SELECT USING (is_published = true OR auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can create/manage guides" ON public.guides;
CREATE POLICY "Authenticated users can create/manage guides" ON public.guides FOR ALL USING (auth.uid() IS NOT NULL);

-- guide_places policies
DROP POLICY IF EXISTS "Anyone can view guide places" ON public.guide_places;
CREATE POLICY "Anyone can view guide places" ON public.guide_places FOR SELECT USING (
  guide_id IN (SELECT id FROM public.guides WHERE is_published = true OR auth.uid() IS NOT NULL)
);

DROP POLICY IF EXISTS "Authenticated users can manage guide places" ON public.guide_places;
CREATE POLICY "Authenticated users can manage guide places" ON public.guide_places FOR ALL USING (auth.uid() IS NOT NULL);

-- follows policies
DROP POLICY IF EXISTS "Anyone can read follows" ON public.follows;
CREATE POLICY "Anyone can read follows" ON public.follows FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can follow others" ON public.follows;
CREATE POLICY "Users can follow others" ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);

DROP POLICY IF EXISTS "Users can unfollow others" ON public.follows;
CREATE POLICY "Users can unfollow others" ON public.follows FOR DELETE USING (auth.uid() = follower_id);

-- waitlist policies
DROP POLICY IF EXISTS "Anyone can join waitlist" ON public.waitlist;
CREATE POLICY "Anyone can join waitlist" ON public.waitlist FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Only admin can view waitlist details" ON public.waitlist;
CREATE POLICY "Only admin can view waitlist details" ON public.waitlist FOR SELECT USING (
  auth.jwt() ->> 'email' LIKE '%admin%'
);

-- cities policies
DROP POLICY IF EXISTS "Anyone can read cities" ON public.cities;
CREATE POLICY "Anyone can read cities" ON public.cities FOR SELECT USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert cities" ON public.cities;
CREATE POLICY "Authenticated users can insert cities" ON public.cities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL OR true);

-- 16. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_social_posts_hashtags ON public.social_posts USING gin(hashtags);
CREATE INDEX IF NOT EXISTS idx_social_posts_brands ON public.social_posts USING gin(mentioned_brands);
CREATE INDEX IF NOT EXISTS idx_social_posts_raw_apify ON public.social_posts USING gin(raw_apify_data);
CREATE INDEX IF NOT EXISTS idx_social_posts_ai_analysis ON public.social_posts USING gin(ai_analysis);
CREATE INDEX IF NOT EXISTS idx_social_posts_ocr_text ON public.social_posts USING gin(to_tsvector('english', coalesce(ocr_combined_text, '')));
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON public.social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_engagement ON public.social_posts(engagement_rate DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_places_user_id ON public.places(user_id);
CREATE INDEX IF NOT EXISTS idx_places_category ON public.places(category);
CREATE INDEX IF NOT EXISTS idx_places_social_post_id ON public.places(social_post_id);

-- 17. SIGNUP TRIGGER FUNCTION (Automatic profile creation on auth.users registration)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, phone)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'Explorer'),
    new.phone
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 18. ENRICHED SOCIAL POSTS VIEW
CREATE OR REPLACE VIEW public.social_posts_enriched AS
SELECT
  sp.id,
  sp.platform,
  sp.content_type,
  sp.content_id,
  sp.author_username,
  sp.owner_full_name,
  sp.short_code,
  sp.caption,
  sp.video_url,
  sp.display_url,
  sp.likes,
  sp.views,
  sp.comments,
  sp.video_plays,
  sp.video_duration,
  sp.dimensions_width,
  sp.dimensions_height,
  sp.hashtags,
  sp.mentions,
  sp.tagged_users,
  sp.music_info,
  sp.mentioned_brands,
  sp.mentioned_locations,
  sp.primary_category,
  sp.secondary_categories,
  sp.content_summary,
  sp.is_promotional,
  sp.is_paid_partnership,
  sp.engagement_rate,
  sp.niche,
  sp.target_audience,
  sp.call_to_actions,
  sp.ocr_combined_text,
  sp.whisper_transcript,
  sp.created_at,
  -- Place details joined
  p.name AS place_name,
  p.city AS place_city,
  p.neighborhood AS place_neighborhood,
  p.category AS place_category,
  p.latitude,
  p.longitude,
  p.address AS place_address
FROM public.social_posts sp
LEFT JOIN public.places p ON sp.place_id = p.id;

-- 19. RELOAD SCHEMA CACHE
NOTIFY pgrst, 'reload schema';
