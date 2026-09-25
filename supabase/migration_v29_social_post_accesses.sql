-- Per-user URL submission audit. This does not create social_posts rows.
-- Apply after migration_v28_social_post_canonical_identity.sql.

CREATE TABLE IF NOT EXISTS public.social_post_accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id uuid NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  canonical_source_key text NOT NULL,
  source_url text NOT NULL,
  event text NOT NULL CHECK (event IN ('started', 'retry', 'joined_processing', 'cache_hit')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_post_accesses_post_time
  ON public.social_post_accesses (social_post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_user_time
  ON public.social_post_accesses (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_post_accesses_source_time
  ON public.social_post_accesses (canonical_source_key, created_at DESC);

ALTER TABLE public.social_post_accesses ENABLE ROW LEVEL SECURITY;
-- No browser-facing policies: access data is written by the server service
-- role and must be exposed only through an authenticated admin endpoint.

NOTIFY pgrst, 'reload schema';
