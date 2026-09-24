-- URL deletion with one JSONB backup row per deletion request.
--
-- The archive table contains exactly three columns:
--   id         - backup identifier
--   data       - complete JSONB snapshots from the five affected source tables
--   created_at - time the snapshot was created
--
-- Install this file once. Afterwards, delete a URL with:
--   SELECT * FROM public.backup_and_delete_social_url('%DdTxlgtuF4j%');
--
-- Accepted inputs:
--   DdTxlgtuF4j
--   %DdTxlgtuF4j%
--   https://www.instagram.com/p/DdTxlgtuF4j/
--   https://www.tiktok.com/t/ZTUKd6ATb/


CREATE TABLE IF NOT EXISTS public.url_deletion_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Convert the older wide url_deletion_backups table, when present, without
-- losing its snapshots. All legacy metadata is moved inside the new data JSONB
-- before the redundant columns are removed.
ALTER TABLE public.url_deletion_backups
  ADD COLUMN IF NOT EXISTS data jsonb;

DO $migration$
DECLARE
  v_has_legacy_snapshot boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'url_deletion_backups'
      AND column_name = 'snapshot'
  ) INTO v_has_legacy_snapshot;

  IF v_has_legacy_snapshot THEN
    EXECUTE $sql$
      UPDATE public.url_deletion_backups
      SET data = COALESCE(
        data,
        jsonb_build_object(
          '_meta', jsonb_build_object(
            'backup_version', 1,
            'migrated_from_legacy_table', true,
            'target_url', target_url,
            'target_post_ids', to_jsonb(target_post_ids),
            'exclusive_place_ids', to_jsonb(exclusive_place_ids),
            'retained_shared_place_ids', to_jsonb(detached_place_ids),
            'deletion_result', deleted_counts
          ),
          'legacy_snapshot', snapshot
        )
      )
      WHERE data IS NULL
    $sql$;
  END IF;

  UPDATE public.url_deletion_backups
  SET data = '{}'::jsonb
  WHERE data IS NULL;
END;
$migration$;

ALTER TABLE public.url_deletion_backups
  ALTER COLUMN data SET NOT NULL;

-- These values are preserved inside data._meta / data.legacy_snapshot above.
ALTER TABLE public.url_deletion_backups
  DROP COLUMN IF EXISTS target_url,
  DROP COLUMN IF EXISTS target_post_ids,
  DROP COLUMN IF EXISTS exclusive_place_ids,
  DROP COLUMN IF EXISTS detached_place_ids,
  DROP COLUMN IF EXISTS snapshot,
  DROP COLUMN IF EXISTS deleted_counts;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.url_deletion_backups'::regclass
      AND conname = 'url_deletion_backups_data_object_check'
  ) THEN
    ALTER TABLE public.url_deletion_backups
      ADD CONSTRAINT url_deletion_backups_data_object_check
      CHECK (jsonb_typeof(data) = 'object');
  END IF;
END;
$constraint$;

CREATE INDEX IF NOT EXISTS idx_url_deletion_backups_created_at
  ON public.url_deletion_backups (created_at DESC);

-- Backups contain captions, OCR and user relationships. Keep them server-only.
ALTER TABLE public.url_deletion_backups ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.url_deletion_backups IS
  'Admin-only JSONB snapshots created immediately before deleting a social URL.';
COMMENT ON COLUMN public.url_deletion_backups.data IS
  'Complete pre-delete rows from social_posts, places, social_post_places, list_places and saved_places.';

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
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_input text := btrim(COALESCE(p_url_or_code, ''));
  v_code text;
  v_url_match text[];
  v_backup_id uuid;
  v_backed_up_at timestamptz := clock_timestamp();
  v_has_places_social_post_id boolean := false;
  v_has_saved_places_social_post_id boolean := false;
  v_posts_deleted bigint := 0;
  v_post_places_deleted bigint := 0;
  v_places_deleted bigint := 0;
  v_saved_deleted bigint := 0;
  v_list_places_deleted bigint := 0;
  v_detached bigint := 0;
BEGIN
  IF v_input = '' THEN
    RAISE EXCEPTION 'URL or short code is required.';
  END IF;

  -- Strip caller-supplied percent signs. Matching below uses literal substring
  -- search, so underscores in Instagram short codes are not SQL wildcards.
  v_code := btrim(v_input, '%');

  IF v_input ~* '^https?://' THEN
    v_url_match := regexp_match(
      v_input,
      '/(?:p|reel|tv|t)/([A-Za-z0-9_-]{5,100})(?:[/?#]|$)',
      'i'
    );
    IF v_url_match IS NULL THEN
      RAISE EXCEPTION 'Could not read a TikTok/Instagram short code from URL "%".', v_input;
    END IF;
    v_code := v_url_match[1];
  END IF;

  IF v_code !~ '^[A-Za-z0-9_-]{5,100}$' THEN
    RAISE EXCEPTION 'Pass a valid TikTok/Instagram URL, short code, or %%short_code%% pattern.';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'places'
      AND column_name = 'social_post_id'
  ) INTO v_has_places_social_post_id;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'saved_places'
      AND column_name = 'social_post_id'
  ) INTO v_has_saved_places_social_post_id;

  -- The lock makes the JSON snapshot and deletes one atomic, consistent unit.
  LOCK TABLE
    public.social_posts,
    public.places,
    public.social_post_places,
    public.saved_places,
    public.list_places
  IN SHARE ROW EXCLUSIVE MODE;

  -- Allow more than one function call inside the same explicit transaction.
  DROP TABLE IF EXISTS pg_temp._url_delete_source_places;
  DROP TABLE IF EXISTS pg_temp._url_delete_target_posts;
  DROP TABLE IF EXISTS pg_temp._url_delete_candidate_place_ids;
  DROP TABLE IF EXISTS pg_temp._url_delete_related_places;
  DROP TABLE IF EXISTS pg_temp._url_delete_exclusive_places;
  DROP TABLE IF EXISTS pg_temp._url_delete_retained_places;
  DROP TABLE IF EXISTS pg_temp._url_delete_social_post_places;
  DROP TABLE IF EXISTS pg_temp._url_delete_saved_places;
  DROP TABLE IF EXISTS pg_temp._url_delete_list_places;

  CREATE TEMP TABLE _url_delete_source_places ON COMMIT DROP AS
  SELECT p.*
  FROM public.places p
  WHERE position(lower(v_code) IN lower(COALESCE(p.source_url, ''))) > 0;

  CREATE TEMP TABLE _url_delete_target_posts ON COMMIT DROP AS
  SELECT sp.*
  FROM public.social_posts sp
  WHERE position(lower(v_code) IN lower(COALESCE(sp.post_url, ''))) > 0
     OR lower(COALESCE(sp.content_id, '')) = lower(v_code)
     OR lower(COALESCE(sp.short_code, '')) = lower(v_code);

  IF NOT EXISTS (SELECT 1 FROM _url_delete_target_posts)
     AND NOT EXISTS (SELECT 1 FROM _url_delete_source_places) THEN
    RAISE EXCEPTION 'No social post or place source URL found for short code "%".', v_code;
  END IF;

  CREATE TEMP TABLE _url_delete_candidate_place_ids (
    id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO _url_delete_candidate_place_ids (id)
  SELECT DISTINCT candidate.place_id
  FROM (
    SELECT spp.place_id
    FROM public.social_post_places spp
    WHERE spp.social_post_id IN (SELECT id FROM _url_delete_target_posts)

    UNION

    SELECT sp.place_id
    FROM public.social_posts sp
    WHERE sp.id IN (SELECT id FROM _url_delete_target_posts)
      AND sp.place_id IS NOT NULL

    UNION

    SELECT p.id
    FROM _url_delete_source_places p
  ) AS candidate
  WHERE candidate.place_id IS NOT NULL;

  IF v_has_places_social_post_id THEN
    EXECUTE $sql$
      INSERT INTO _url_delete_candidate_place_ids (id)
      SELECT p.id
      FROM public.places p
      WHERE p.social_post_id IN (SELECT id FROM _url_delete_target_posts)
      ON CONFLICT (id) DO NOTHING
    $sql$;
  END IF;

  -- Archive every related place, including shared places that must be retained.
  CREATE TEMP TABLE _url_delete_related_places ON COMMIT DROP AS
  SELECT p.*
  FROM public.places p
  JOIN _url_delete_candidate_place_ids candidate ON candidate.id = p.id;

  -- Delete a place only when no non-target social post still references it.
  CREATE TEMP TABLE _url_delete_exclusive_places ON COMMIT DROP AS
  SELECT p.*
  FROM _url_delete_related_places p
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.social_post_places spp
    WHERE spp.place_id = p.id
      AND spp.social_post_id NOT IN (SELECT id FROM _url_delete_target_posts)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.social_posts sp
    WHERE sp.place_id = p.id
      AND sp.id NOT IN (SELECT id FROM _url_delete_target_posts)
  );

  IF v_has_places_social_post_id THEN
    EXECUTE $sql$
      DELETE FROM _url_delete_exclusive_places exclusive_place
      USING public.places p
      WHERE exclusive_place.id = p.id
        AND p.social_post_id IS NOT NULL
        AND p.social_post_id NOT IN (SELECT id FROM _url_delete_target_posts)
    $sql$;
  END IF;

  CREATE TEMP TABLE _url_delete_retained_places ON COMMIT DROP AS
  SELECT p.*
  FROM _url_delete_related_places p
  WHERE NOT EXISTS (
    SELECT 1
    FROM _url_delete_exclusive_places exclusive_place
    WHERE exclusive_place.id = p.id
  );

  CREATE TEMP TABLE _url_delete_social_post_places ON COMMIT DROP AS
  SELECT spp.*
  FROM public.social_post_places spp
  WHERE spp.social_post_id IN (SELECT id FROM _url_delete_target_posts);

  -- saved_places.social_post_id was introduced by migration v24, but older
  -- databases may not have it. The dynamic branch supports both schemas.
  CREATE TEMP TABLE _url_delete_saved_places ON COMMIT DROP AS
  SELECT saved.*
  FROM public.saved_places saved
  WHERE saved.place_id IN (SELECT id FROM _url_delete_exclusive_places);

  IF v_has_saved_places_social_post_id THEN
    EXECUTE $sql$
      INSERT INTO _url_delete_saved_places
      SELECT saved.*
      FROM public.saved_places saved
      WHERE saved.social_post_id IN (SELECT id FROM _url_delete_target_posts)
        AND NOT EXISTS (
          SELECT 1
          FROM _url_delete_saved_places existing
          WHERE existing.id = saved.id
        )
    $sql$;
  END IF;

  CREATE TEMP TABLE _url_delete_list_places ON COMMIT DROP AS
  SELECT lp.*
  FROM public.list_places lp
  WHERE lp.place_id IN (SELECT id FROM _url_delete_exclusive_places);

  -- Write the complete pre-delete snapshot before modifying any source row.
  INSERT INTO public.url_deletion_backups (data, created_at)
  VALUES (
    jsonb_build_object(
      '_meta', jsonb_build_object(
        'backup_version', 2,
        'input', v_input,
        'short_code', v_code,
        'backed_up_at', v_backed_up_at,
        'target_post_ids', COALESCE(
          (SELECT jsonb_agg(id ORDER BY id) FROM _url_delete_target_posts),
          '[]'::jsonb
        ),
        'exclusive_place_ids', COALESCE(
          (SELECT jsonb_agg(id ORDER BY id) FROM _url_delete_exclusive_places),
          '[]'::jsonb
        ),
        'retained_shared_place_ids', COALESCE(
          (SELECT jsonb_agg(id ORDER BY id) FROM _url_delete_retained_places),
          '[]'::jsonb
        ),
        'deletion_result', NULL
      ),
      'social_posts', COALESCE(
        (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id) FROM _url_delete_target_posts row_data),
        '[]'::jsonb
      ),
      'places', COALESCE(
        (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id) FROM _url_delete_related_places row_data),
        '[]'::jsonb
      ),
      'social_post_places', COALESCE(
        (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id) FROM _url_delete_social_post_places row_data),
        '[]'::jsonb
      ),
      'list_places', COALESCE(
        (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id) FROM _url_delete_list_places row_data),
        '[]'::jsonb
      ),
      'saved_places', COALESCE(
        (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id) FROM _url_delete_saved_places row_data),
        '[]'::jsonb
      )
    ),
    v_backed_up_at
  )
  RETURNING id INTO v_backup_id;

  -- Explicit deletes preserve accurate counts and avoid depending on cascades.
  DELETE FROM public.saved_places saved
  USING _url_delete_saved_places target
  WHERE saved.id = target.id;
  GET DIAGNOSTICS v_saved_deleted = ROW_COUNT;

  DELETE FROM public.list_places lp
  USING _url_delete_list_places target
  WHERE lp.id = target.id;
  GET DIAGNOSTICS v_list_places_deleted = ROW_COUNT;

  DELETE FROM public.social_post_places spp
  USING _url_delete_social_post_places target
  WHERE spp.id = target.id;
  GET DIAGNOSTICS v_post_places_deleted = ROW_COUNT;

  DELETE FROM public.places p
  USING _url_delete_exclusive_places target
  WHERE p.id = target.id;
  GET DIAGNOSTICS v_places_deleted = ROW_COUNT;

  -- A shared legacy place may point at the post being deleted. Detach that old
  -- one-to-many reference so deleting the post cannot cascade-delete the place.
  IF v_has_places_social_post_id THEN
    EXECUTE $sql$
      UPDATE public.places p
      SET social_post_id = NULL
      WHERE p.id IN (SELECT id FROM _url_delete_retained_places)
        AND p.social_post_id IN (SELECT id FROM _url_delete_target_posts)
    $sql$;
    GET DIAGNOSTICS v_detached = ROW_COUNT;
  END IF;

  DELETE FROM public.social_posts sp
  USING _url_delete_target_posts target
  WHERE sp.id = target.id;
  GET DIAGNOSTICS v_posts_deleted = ROW_COUNT;

  UPDATE public.url_deletion_backups backup
  SET data = jsonb_set(
    backup.data,
    '{_meta}',
    (backup.data -> '_meta') || jsonb_build_object(
      'deletion_result', jsonb_build_object(
        'social_posts_deleted', v_posts_deleted,
        'social_post_places_deleted', v_post_places_deleted,
        'exclusive_places_deleted', v_places_deleted,
        'saved_places_deleted', v_saved_deleted,
        'list_places_deleted', v_list_places_deleted,
        'legacy_places_detached_not_deleted', v_detached
      )
    ),
    true
  )
  WHERE backup.id = v_backup_id;

  RETURN QUERY
  SELECT
    v_backup_id,
    v_posts_deleted,
    v_post_places_deleted,
    v_places_deleted,
    v_saved_deleted,
    v_list_places_deleted,
    v_detached;
END;
$function$;

REVOKE ALL ON FUNCTION public.backup_and_delete_social_url(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backup_and_delete_social_url(text) TO service_role;

COMMENT ON FUNCTION public.backup_and_delete_social_url(text) IS
  'Admin-only: stores one JSONB backup row, then deletes one social URL by URL or short code.';

-- Example after installing this file:
-- SELECT *
-- FROM public.backup_and_delete_social_url('%DdTxlgtuF4j%');

-- Inspect the newest backup:
-- SELECT id, data, created_at
-- FROM public.url_deletion_backups
-- ORDER BY created_at DESC
-- LIMIT 1;

-- Restore one deletion by its url_deletion_backups.id:
-- SELECT *
-- FROM public.restore_social_url_backup('00000000-0000-0000-0000-000000000000'::uuid);

CREATE OR REPLACE FUNCTION public.restore_social_url_backup(p_backup_id uuid)
RETURNS TABLE (
  backup_id uuid,
  social_posts_restored bigint,
  places_restored bigint,
  social_post_places_restored bigint,
  list_places_restored bigint,
  saved_places_restored bigint,
  social_post_place_links_restored bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_data jsonb;
  v_social_posts jsonb;
  v_places jsonb;
  v_social_post_places jsonb;
  v_list_places jsonb;
  v_saved_places jsonb;
  v_columns text;
  v_posts_restored bigint := 0;
  v_places_restored bigint := 0;
  v_post_places_restored bigint := 0;
  v_list_places_restored bigint := 0;
  v_saved_places_restored bigint := 0;
  v_post_links_restored bigint := 0;
  v_restore_event jsonb;
BEGIN
  IF p_backup_id IS NULL THEN
    RAISE EXCEPTION 'Backup id is required.';
  END IF;

  -- Use the same table-lock order as the delete function. A restore is therefore
  -- atomic and cannot race a delete that touches the same source tables.
  LOCK TABLE
    public.social_posts,
    public.places,
    public.social_post_places,
    public.saved_places,
    public.list_places
  IN SHARE ROW EXCLUSIVE MODE;

  SELECT backup.data
  INTO v_data
  FROM public.url_deletion_backups backup
  WHERE backup.id = p_backup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'URL deletion backup "%" was not found.', p_backup_id;
  END IF;

  v_social_posts := v_data -> 'social_posts';
  v_places := v_data -> 'places';
  v_social_post_places := v_data -> 'social_post_places';
  v_list_places := v_data -> 'list_places';
  v_saved_places := v_data -> 'saved_places';

  IF jsonb_typeof(v_social_posts) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_places) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_social_post_places) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_list_places) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_saved_places) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION
      'Backup "%" is not a restorable version-2 URL backup.',
      p_backup_id;
  END IF;

  -- Every archived source row must retain its original primary key. Refuse a
  -- malformed backup instead of silently generating replacement identifiers.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT value FROM jsonb_array_elements(v_social_posts)
      UNION ALL
      SELECT value FROM jsonb_array_elements(v_places)
      UNION ALL
      SELECT value FROM jsonb_array_elements(v_social_post_places)
      UNION ALL
      SELECT value FROM jsonb_array_elements(v_list_places)
      UNION ALL
      SELECT value FROM jsonb_array_elements(v_saved_places)
    ) archived
    WHERE jsonb_typeof(archived.value) IS DISTINCT FROM 'object'
       OR NOT (archived.value ? 'id')
       OR archived.value ->> 'id' IS NULL
  ) THEN
    RAISE EXCEPTION 'Backup "%" contains a malformed row without an id.', p_backup_id;
  END IF;

  -- social_posts and places can reference each other. Insert posts without
  -- place_id first, insert places next, then restore each post.place_id value.
  IF jsonb_array_length(v_social_posts) > 0 THEN
    SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.social_posts'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
      AND attribute.attname <> 'place_id'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_social_posts) archived(value)
        WHERE archived.value ? attribute.attname
      );

    IF v_columns IS NULL OR position('id' IN v_columns) = 0 THEN
      RAISE EXCEPTION 'Backup "%" has no restorable social_posts columns.', p_backup_id;
    END IF;

    EXECUTE format(
      'INSERT INTO public.social_posts (%1$s)
       SELECT %1$s
       FROM jsonb_populate_recordset(NULL::public.social_posts, $1)
       ON CONFLICT (id) DO NOTHING',
      v_columns
    ) USING v_social_posts;
    GET DIAGNOSTICS v_posts_restored = ROW_COUNT;
  END IF;

  IF jsonb_array_length(v_places) > 0 THEN
    SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.places'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_places) archived(value)
        WHERE archived.value ? attribute.attname
      );

    IF v_columns IS NULL OR position('id' IN v_columns) = 0 THEN
      RAISE EXCEPTION 'Backup "%" has no restorable places columns.', p_backup_id;
    END IF;

    EXECUTE format(
      'INSERT INTO public.places (%1$s)
       SELECT %1$s
       FROM jsonb_populate_recordset(NULL::public.places, $1)
       ON CONFLICT (id) DO NOTHING',
      v_columns
    ) USING v_places;
    GET DIAGNOSTICS v_places_restored = ROW_COUNT;
  END IF;

  IF jsonb_array_length(v_social_posts) > 0 THEN
    UPDATE public.social_posts target
    SET place_id = archived.place_id
    FROM jsonb_populate_recordset(
      NULL::public.social_posts,
      v_social_posts
    ) archived
    WHERE target.id = archived.id
      AND target.place_id IS DISTINCT FROM archived.place_id;
    GET DIAGNOSTICS v_post_links_restored = ROW_COUNT;
  END IF;

  IF jsonb_array_length(v_social_post_places) > 0 THEN
    SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.social_post_places'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_social_post_places) archived(value)
        WHERE archived.value ? attribute.attname
      );

    EXECUTE format(
      'INSERT INTO public.social_post_places (%1$s)
       SELECT %1$s
       FROM jsonb_populate_recordset(NULL::public.social_post_places, $1)
       ON CONFLICT (id) DO NOTHING',
      v_columns
    ) USING v_social_post_places;
    GET DIAGNOSTICS v_post_places_restored = ROW_COUNT;
  END IF;

  IF jsonb_array_length(v_list_places) > 0 THEN
    SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.list_places'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_list_places) archived(value)
        WHERE archived.value ? attribute.attname
      );

    EXECUTE format(
      'INSERT INTO public.list_places (%1$s)
       SELECT %1$s
       FROM jsonb_populate_recordset(NULL::public.list_places, $1)
       ON CONFLICT (id) DO NOTHING',
      v_columns
    ) USING v_list_places;
    GET DIAGNOSTICS v_list_places_restored = ROW_COUNT;
  END IF;

  IF jsonb_array_length(v_saved_places) > 0 THEN
    SELECT string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.saved_places'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attgenerated = ''
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_saved_places) archived(value)
        WHERE archived.value ? attribute.attname
      );

    EXECUTE format(
      'INSERT INTO public.saved_places (%1$s)
       SELECT %1$s
       FROM jsonb_populate_recordset(NULL::public.saved_places, $1)
       ON CONFLICT (id) DO NOTHING',
      v_columns
    ) USING v_saved_places;
    GET DIAGNOSTICS v_saved_places_restored = ROW_COUNT;
  END IF;

  v_restore_event := jsonb_build_object(
    'status', 'completed',
    'restored_at', clock_timestamp(),
    'social_posts_restored', v_posts_restored,
    'places_restored', v_places_restored,
    'social_post_places_restored', v_post_places_restored,
    'list_places_restored', v_list_places_restored,
    'saved_places_restored', v_saved_places_restored,
    'social_post_place_links_restored', v_post_links_restored
  );

  UPDATE public.url_deletion_backups backup
  SET data = jsonb_set(
    backup.data,
    '{_meta}',
    (backup.data -> '_meta') || jsonb_build_object(
      'last_restore_result', v_restore_event,
      'restore_history',
        COALESCE(backup.data #> '{_meta,restore_history}', '[]'::jsonb)
        || jsonb_build_array(v_restore_event)
    ),
    true
  )
  WHERE backup.id = p_backup_id;

  RETURN QUERY
  SELECT
    p_backup_id,
    v_posts_restored,
    v_places_restored,
    v_post_places_restored,
    v_list_places_restored,
    v_saved_places_restored,
    v_post_links_restored;
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_social_url_backup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_social_url_backup(uuid) TO service_role;

COMMENT ON FUNCTION public.restore_social_url_backup(uuid) IS
  'Admin-only: atomically restores the five source-table snapshots stored in one URL deletion backup row.';
