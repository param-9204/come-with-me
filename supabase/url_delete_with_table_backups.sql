-- URL deletion with relational backups.
-- Change only the TikTok/Instagram short code in `_delete_params` below.
-- This script copies complete source rows into one backup table per source
-- table, then deletes only data owned exclusively by the target post.
-- Lists and profiles are archived as context but are never deleted: they can
-- contain unrelated user data.

CREATE TABLE IF NOT EXISTS public.url_delete_backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source_short_code text NOT NULL,
  target_post_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  exclusive_place_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  detached_place_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  deleted_counts jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- LIKE copies all current source columns but deliberately does not copy source
-- primary keys, foreign keys, or identities. The same source row can therefore
-- be backed up again under a different backup_run_id.
CREATE TABLE IF NOT EXISTS public.url_delete_backup_social_posts (LIKE public.social_posts);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_places (LIKE public.places);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_social_post_places (LIKE public.social_post_places);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_saved_places (LIKE public.saved_places);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_list_places (LIKE public.list_places);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_lists (LIKE public.lists);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_list_collaborators (LIKE public.list_collaborators);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_profiles (LIKE public.profiles);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_extraction_runs (LIKE public.extraction_runs);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_extraction_run_events (LIKE public.extraction_run_events);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_extraction_stage_runs (LIKE public.extraction_stage_runs);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_extraction_evidence (LIKE public.extraction_evidence);
CREATE TABLE IF NOT EXISTS public.url_delete_backup_extraction_place_candidates (LIKE public.extraction_place_candidates);

-- Add backup metadata to each duplicate table. The setup is safe to rerun.
-- If a future migration adds a source column, add that same column to its
-- matching backup table before using the deletion script again.
ALTER TABLE public.url_delete_backup_social_posts ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_social_posts ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_social_posts ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_places ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_places ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_places ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_social_post_places ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_social_post_places ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_social_post_places ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_saved_places ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_saved_places ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_saved_places ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_list_places ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_list_places ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_list_places ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_lists ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_lists ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_lists ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_list_collaborators ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_list_collaborators ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_list_collaborators ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_profiles ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_profiles ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_profiles ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_extraction_runs ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_extraction_runs ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_extraction_runs ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_extraction_run_events ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_extraction_run_events ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_extraction_run_events ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_extraction_stage_runs ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_extraction_stage_runs ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_extraction_stage_runs ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_extraction_evidence ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_extraction_evidence ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_extraction_evidence ADD COLUMN IF NOT EXISTS backup_action text;
ALTER TABLE public.url_delete_backup_extraction_place_candidates ADD COLUMN IF NOT EXISTS backup_run_id uuid;
ALTER TABLE public.url_delete_backup_extraction_place_candidates ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE public.url_delete_backup_extraction_place_candidates ADD COLUMN IF NOT EXISTS backup_action text;

CREATE INDEX IF NOT EXISTS idx_url_delete_backup_runs_created_at ON public.url_delete_backup_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_social_posts_run ON public.url_delete_backup_social_posts (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_places_run ON public.url_delete_backup_places (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_social_post_places_run ON public.url_delete_backup_social_post_places (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_saved_places_run ON public.url_delete_backup_saved_places (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_list_places_run ON public.url_delete_backup_list_places (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_lists_run ON public.url_delete_backup_lists (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_list_collaborators_run ON public.url_delete_backup_list_collaborators (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_profiles_run ON public.url_delete_backup_profiles (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_extraction_runs_run ON public.url_delete_backup_extraction_runs (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_extraction_events_run ON public.url_delete_backup_extraction_run_events (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_extraction_stages_run ON public.url_delete_backup_extraction_stage_runs (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_extraction_evidence_run ON public.url_delete_backup_extraction_evidence (backup_run_id);
CREATE INDEX IF NOT EXISTS idx_url_delete_backup_extraction_candidates_run ON public.url_delete_backup_extraction_place_candidates (backup_run_id);

ALTER TABLE public.url_delete_backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_social_post_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_saved_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_list_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_list_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_extraction_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_extraction_stage_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_extraction_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_delete_backup_extraction_place_candidates ENABLE ROW LEVEL SECURITY;

-- One-time installation. After this file has been run once, delete any URL
-- with one short query, for example:
-- SELECT * FROM public.backup_and_delete_social_url('ZTyFrPfGS');
CREATE OR REPLACE FUNCTION public.backup_and_delete_social_url(p_url_or_code text)
RETURNS TABLE (
  backup_run_id uuid,
  social_posts_deleted bigint,
  social_post_places_deleted bigint,
  exclusive_places_deleted bigint,
  saved_places_deleted bigint,
  list_places_deleted bigint,
  legacy_places_detached_not_deleted bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_input text := trim(p_url_or_code);
  v_code text;
  v_backup_id uuid;
  v_target_post_ids uuid[];
  v_exclusive_place_ids uuid[];
  v_detached_place_ids uuid[];
  v_posts_deleted bigint := 0;
  v_post_places_deleted bigint := 0;
  v_places_deleted bigint := 0;
  v_saved_deleted bigint := 0;
  v_list_places_deleted bigint := 0;
  v_detached bigint := 0;
  v_has_places_social_post_id boolean := false;
BEGIN
  -- Accept all of these forms:
  --   ZTUKd6ATb
  --   %ZTUKd6ATb%
  --   https://www.tiktok.com/t/ZTUKd6ATb/
  --   https://www.instagram.com/p/DcUouRvxXhS/
  v_code := trim(both '%' from v_input);
  IF v_input ~* '^https?://' THEN
    v_code := regexp_replace(
      v_input,
      '^https?://[^/]+/(p|reel|tv|t)/([^/?#]+).*$',
      '\2',
      'i'
    );
  END IF;

  IF v_code !~ '^[A-Za-z0-9_-]{5,100}$' THEN
    RAISE EXCEPTION 'Pass a valid TikTok/Instagram URL, short code, or %%short_code%% pattern.';
  END IF;

  IF to_regclass('public.url_delete_backup_runs') IS NULL
     OR to_regclass('public.url_delete_backup_social_posts') IS NULL THEN
    RAISE EXCEPTION 'Run this installer once before calling the delete function.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'places'
      AND column_name = 'social_post_id'
  ) INTO v_has_places_social_post_id;

  LOCK TABLE
    public.social_posts,
    public.places,
    public.social_post_places,
    public.saved_places,
    public.list_places,
    public.lists,
    public.profiles
  IN SHARE ROW EXCLUSIVE MODE;

  -- Match place.source_url independently. A source-matched place must not
  -- select unrelated posts that merely share that place.
  CREATE TEMP TABLE _url_delete_source_places ON COMMIT DROP AS
  SELECT p.*
  FROM public.places p
  WHERE p.source_url ILIKE '%' || v_code || '%';

  CREATE TEMP TABLE _url_delete_target_posts ON COMMIT DROP AS
  SELECT sp.*
  FROM public.social_posts sp
  WHERE sp.post_url ILIKE '%' || v_code || '%';

  IF NOT EXISTS (SELECT 1 FROM _url_delete_target_posts)
     AND NOT EXISTS (SELECT 1 FROM _url_delete_source_places) THEN
    RAISE EXCEPTION 'No social post or place source URL found for short code "%".', v_code;
  END IF;

  CREATE TEMP TABLE _url_delete_candidate_places ON COMMIT DROP AS
  SELECT DISTINCT place_id AS id
  FROM (
    SELECT spp.place_id
    FROM public.social_post_places spp
    WHERE spp.social_post_id IN (SELECT id FROM _url_delete_target_posts)
    UNION
    SELECT sp.place_id
    FROM public.social_posts sp
    WHERE sp.id IN (SELECT id FROM _url_delete_target_posts) AND sp.place_id IS NOT NULL
    UNION
    SELECT id AS place_id
    FROM _url_delete_source_places
  ) candidates
  WHERE place_id IS NOT NULL;

  IF v_has_places_social_post_id THEN
    EXECUTE $legacy$
      INSERT INTO _url_delete_candidate_places (id)
      SELECT p.id
      FROM public.places p
      WHERE p.social_post_id IN (SELECT id FROM _url_delete_target_posts)
        AND NOT EXISTS (
          SELECT 1 FROM _url_delete_candidate_places existing
          WHERE existing.id = p.id
        )
    $legacy$;
  END IF;

  CREATE TEMP TABLE _url_delete_exclusive_places ON COMMIT DROP AS
  SELECT p.*
  FROM public.places p
  JOIN _url_delete_candidate_places cp ON cp.id = p.id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.social_post_places spp
    WHERE spp.place_id = p.id
      AND spp.social_post_id NOT IN (SELECT id FROM _url_delete_target_posts)
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.social_posts sp
    WHERE sp.place_id = p.id
      AND sp.id NOT IN (SELECT id FROM _url_delete_target_posts)
  );

  IF v_has_places_social_post_id THEN
    EXECUTE $legacy$
      DELETE FROM _url_delete_exclusive_places ep
      USING public.places p
      WHERE ep.id = p.id
        AND p.social_post_id IS NOT NULL
        AND p.social_post_id NOT IN (SELECT id FROM _url_delete_target_posts)
    $legacy$;
  END IF;

  CREATE TEMP TABLE _url_delete_detached_places ON COMMIT DROP AS
  SELECT p.* FROM public.places p WHERE FALSE;

  IF v_has_places_social_post_id THEN
    EXECUTE $legacy$
      INSERT INTO _url_delete_detached_places
      SELECT p.*
      FROM public.places p
      JOIN _url_delete_candidate_places cp ON cp.id = p.id
      WHERE p.social_post_id IN (SELECT id FROM _url_delete_target_posts)
        AND p.id NOT IN (SELECT id FROM _url_delete_exclusive_places)
    $legacy$;
  END IF;

  CREATE TEMP TABLE _url_delete_saved_places ON COMMIT DROP AS
  SELECT sp.*
  FROM public.saved_places sp
  WHERE sp.social_post_id IN (SELECT id FROM _url_delete_target_posts)
     OR sp.place_id IN (SELECT id FROM _url_delete_exclusive_places);

  CREATE TEMP TABLE _url_delete_list_places ON COMMIT DROP AS
  SELECT lp.* FROM public.list_places lp
  WHERE lp.place_id IN (SELECT id FROM _url_delete_exclusive_places);

  CREATE TEMP TABLE _url_delete_lists ON COMMIT DROP AS
  SELECT l.* FROM public.lists l
  WHERE l.id IN (SELECT DISTINCT list_id FROM _url_delete_list_places);

  CREATE TEMP TABLE _url_delete_profiles ON COMMIT DROP AS
  SELECT pr.* FROM public.profiles pr
  WHERE pr.id IN (
    SELECT user_id FROM _url_delete_target_posts WHERE user_id IS NOT NULL
    UNION SELECT user_id FROM _url_delete_saved_places
    UNION SELECT user_id FROM _url_delete_lists
  );

  CREATE TEMP TABLE _url_delete_runs ON COMMIT DROP AS
  SELECT er.* FROM public.extraction_runs er
  WHERE er.social_post_id IN (SELECT id FROM _url_delete_target_posts)
     OR er.input_url ILIKE '%' || v_code || '%';

  CREATE TEMP TABLE _url_delete_candidates ON COMMIT DROP AS
  SELECT epc.* FROM public.extraction_place_candidates epc
  WHERE epc.run_id IN (SELECT id FROM _url_delete_runs)
     OR epc.place_id IN (SELECT id FROM _url_delete_exclusive_places);

  SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_target_post_ids FROM _url_delete_target_posts;
  SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_exclusive_place_ids FROM _url_delete_exclusive_places;
  SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_detached_place_ids FROM _url_delete_detached_places;

  INSERT INTO public.url_delete_backup_runs (
    source_short_code, target_post_ids, exclusive_place_ids, detached_place_ids
  ) VALUES (
    v_code, v_target_post_ids, v_exclusive_place_ids, v_detached_place_ids
  ) RETURNING id INTO v_backup_id;

  INSERT INTO public.url_delete_backup_social_posts
  SELECT x.*, v_backup_id, now(), 'deleted' FROM _url_delete_target_posts x;
  INSERT INTO public.url_delete_backup_places
  SELECT x.*, v_backup_id, now(), 'deleted' FROM _url_delete_exclusive_places x;
  INSERT INTO public.url_delete_backup_places
  SELECT x.*, v_backup_id, now(), 'detached_not_deleted' FROM _url_delete_detached_places x;
  INSERT INTO public.url_delete_backup_social_post_places
  SELECT spp.*, v_backup_id, now(), 'deleted'
  FROM public.social_post_places spp
  WHERE spp.social_post_id IN (SELECT id FROM _url_delete_target_posts);
  INSERT INTO public.url_delete_backup_saved_places
  SELECT x.*, v_backup_id, now(), 'deleted' FROM _url_delete_saved_places x;
  INSERT INTO public.url_delete_backup_list_places
  SELECT x.*, v_backup_id, now(), 'deleted' FROM _url_delete_list_places x;
  INSERT INTO public.url_delete_backup_lists
  SELECT x.*, v_backup_id, now(), 'context_not_deleted' FROM _url_delete_lists x;
  INSERT INTO public.url_delete_backup_list_collaborators
  SELECT lc.*, v_backup_id, now(), 'context_not_deleted'
  FROM public.list_collaborators lc
  WHERE lc.list_id IN (SELECT id FROM _url_delete_lists);
  INSERT INTO public.url_delete_backup_profiles
  SELECT x.*, v_backup_id, now(), 'context_not_deleted' FROM _url_delete_profiles x;
  INSERT INTO public.url_delete_backup_extraction_runs
  SELECT x.*, v_backup_id, now(), 'context_not_deleted' FROM _url_delete_runs x;
  INSERT INTO public.url_delete_backup_extraction_run_events
  SELECT e.*, v_backup_id, now(), 'context_not_deleted'
  FROM public.extraction_run_events e
  WHERE e.run_id IN (SELECT id FROM _url_delete_runs);
  INSERT INTO public.url_delete_backup_extraction_stage_runs
  SELECT s.*, v_backup_id, now(), 'context_not_deleted'
  FROM public.extraction_stage_runs s
  WHERE s.run_id IN (SELECT id FROM _url_delete_runs);
  INSERT INTO public.url_delete_backup_extraction_evidence
  SELECT e.*, v_backup_id, now(), 'context_not_deleted'
  FROM public.extraction_evidence e
  WHERE e.run_id IN (SELECT id FROM _url_delete_runs);
  INSERT INTO public.url_delete_backup_extraction_place_candidates
  SELECT x.*, v_backup_id, now(), 'context_not_deleted' FROM _url_delete_candidates x;

  DELETE FROM public.saved_places sp
  USING _url_delete_saved_places target
  WHERE sp.id = target.id;
  GET DIAGNOSTICS v_saved_deleted = ROW_COUNT;

  DELETE FROM public.list_places lp
  USING _url_delete_list_places target
  WHERE lp.id = target.id;
  GET DIAGNOSTICS v_list_places_deleted = ROW_COUNT;

  DELETE FROM public.social_post_places spp
  WHERE spp.social_post_id IN (SELECT id FROM _url_delete_target_posts);
  GET DIAGNOSTICS v_post_places_deleted = ROW_COUNT;

  DELETE FROM public.places p
  USING _url_delete_exclusive_places target
  WHERE p.id = target.id;
  GET DIAGNOSTICS v_places_deleted = ROW_COUNT;

  IF v_has_places_social_post_id THEN
    EXECUTE $legacy$
      UPDATE public.places p
      SET social_post_id = NULL
      WHERE p.id IN (SELECT id FROM _url_delete_detached_places)
    $legacy$;
    GET DIAGNOSTICS v_detached = ROW_COUNT;
  END IF;

  DELETE FROM public.social_posts sp
  USING _url_delete_target_posts target
  WHERE sp.id = target.id;
  GET DIAGNOSTICS v_posts_deleted = ROW_COUNT;

  UPDATE public.url_delete_backup_runs
  SET deleted_counts = jsonb_build_object(
    'social_posts_deleted', v_posts_deleted,
    'social_post_places_deleted', v_post_places_deleted,
    'exclusive_places_deleted', v_places_deleted,
    'saved_places_deleted', v_saved_deleted,
    'list_places_deleted', v_list_places_deleted,
    'legacy_places_detached_not_deleted', v_detached,
    'lists_deleted', 0,
    'profiles_deleted', 0,
    'audit_log_rows_deleted', 0
  )
  WHERE id = v_backup_id;

  RETURN QUERY SELECT
    v_backup_id,
    v_posts_deleted,
    v_post_places_deleted,
    v_places_deleted,
    v_saved_deleted,
    v_list_places_deleted,
    v_detached;
END;
$$;

REVOKE ALL ON FUNCTION public.backup_and_delete_social_url(text) FROM PUBLIC;
COMMENT ON FUNCTION public.backup_and_delete_social_url(text) IS
  'Admin-only: backs up every affected source row to separate backup tables, then deletes one social URL by short code.';
