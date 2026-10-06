-- Private Scout trip plans with optional, explicit reusable templates.

BEGIN;

CREATE TABLE IF NOT EXISTS public.trip_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reuse_key text NOT NULL,
  intent_key text NOT NULL,
  input_data jsonb NOT NULL,
  response_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_plans_user_reuse_key_unique UNIQUE (user_id, reuse_key)
);

CREATE INDEX IF NOT EXISTS idx_trip_plans_intent
  ON public.trip_plans (intent_key, updated_at DESC);

ALTER TABLE public.trip_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own trip plans" ON public.trip_plans;
CREATE POLICY "Users can read their own trip plans"
  ON public.trip_plans FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own trip plans" ON public.trip_plans;
CREATE POLICY "Users can create their own trip plans"
  ON public.trip_plans FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own trip plans" ON public.trip_plans;
CREATE POLICY "Users can update their own trip plans"
  ON public.trip_plans FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own trip plans" ON public.trip_plans;
CREATE POLICY "Users can delete their own trip plans"
  ON public.trip_plans FOR DELETE
  USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';

COMMIT;
