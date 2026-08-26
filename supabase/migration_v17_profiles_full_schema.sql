-- ── MIGRATION V17: PROFILES TABLE DEFINITIONS ──
-- This migration script contains both fresh setup and upgrade configurations.

-- =========================================================================
-- OPTION A: FRESH SETUP (Use this if creating the profiles table from scratch)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text UNIQUE NOT NULL,
  display_name text,
  phone text,
  signup_method text,
  last_sign_in_method text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- =========================================================================
-- OPTION B: UPGRADE EXISTING TABLE (Use this to add missing fields to your existing table)
-- =========================================================================
-- 1. Safely add missing columns
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS clerk_user_id text,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS signup_method text,
  ADD COLUMN IF NOT EXISTS last_sign_in_method text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. Make clerk_user_id NOT NULL (Ensure no NULL values exist first)
-- If you have pre-existing rows, assign default values before executing this statement.
ALTER TABLE public.profiles ALTER COLUMN clerk_user_id SET NOT NULL;

-- 3. Add UNIQUE constraint to clerk_user_id
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_clerk_user_id_key;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_clerk_user_id_key UNIQUE (clerk_user_id);

-- =========================================================================
-- INDEXES & CACHE RELOAD
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_clerk_user_id ON public.profiles(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_signup_method ON public.profiles(signup_method);

NOTIFY pgrst, 'reload schema';
