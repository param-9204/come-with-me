-- Existing v34 deployments: remove opt-in sharing. Every saved plan is now
-- reusable by Scout for any user with the same normalized trip request.

BEGIN;

ALTER TABLE public.trip_plans DROP COLUMN IF EXISTS is_reusable;
ALTER TABLE public.trip_plans DROP COLUMN IF EXISTS template_key;

DROP INDEX IF EXISTS public.idx_trip_plans_reusable_intent;
CREATE INDEX IF NOT EXISTS idx_trip_plans_intent
  ON public.trip_plans (intent_key, updated_at DESC);

NOTIFY pgrst, 'reload schema';

COMMIT;
