-- ── MIGRATION V16: RENAME AND ADD FIELDS TO PROFILES ──
-- Run this inside your Supabase SQL Editor or raw PostgreSQL client to update your profiles table schema.

-- 1. Rename provider_id to clerk_user_id (if provider_id exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'provider_id') THEN
    ALTER TABLE public.profiles RENAME COLUMN provider_id TO clerk_user_id;
  END IF;
END $$;

-- 2. Rename provider_name to signup_method (if provider_name exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'provider_name') THEN
    ALTER TABLE public.profiles RENAME COLUMN provider_name TO signup_method;
  END IF;
END $$;

-- 3. Add columns if they do not exist
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS clerk_user_id text,
  ADD COLUMN IF NOT EXISTS signup_method text,
  ADD COLUMN IF NOT EXISTS last_sign_in_method text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 4. Set clerk_user_id constraint checks
-- (Ensure that you do not have any pre-existing rows with NULL values for clerk_user_id before applying the NOT NULL constraint)
ALTER TABLE public.profiles ALTER COLUMN clerk_user_id SET NOT NULL;

-- 5. Add unique key constraint to clerk_user_id
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_clerk_user_id_key;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_clerk_user_id_key UNIQUE (clerk_user_id);

-- 6. Recreate lookup indexes
DROP INDEX IF EXISTS idx_profiles_provider_identity;
CREATE INDEX IF NOT EXISTS idx_profiles_clerk_user_identity 
  ON public.profiles(clerk_user_id, signup_method);

-- 7. Reload schema cache
NOTIFY pgrst, 'reload schema';
