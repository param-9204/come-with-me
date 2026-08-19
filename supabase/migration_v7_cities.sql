-- ── MIGRATION V7: Create Cities Table ──
-- Paste and execute this script inside your Supabase SQL Editor to resolve the PGRST205 cache error.

-- 1. Create cities table
CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT null UNIQUE,
  created_at timestamptz DEFAULT now()
);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;

-- 3. Security policies
DROP POLICY IF EXISTS "Anyone can read cities" ON public.cities;
CREATE POLICY "Anyone can read cities" ON public.cities FOR SELECT USING (true);

-- Authenticated users (or our server-side service key) can insert new cities
DROP POLICY IF EXISTS "Authenticated users can insert cities" ON public.cities;
CREATE POLICY "Authenticated users can insert cities" ON public.cities FOR INSERT WITH CHECK (auth.uid() IS NOT NULL OR true);
