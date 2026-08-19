-- ── MIGRATION V9: Add Lat/Long to Cities Table ──
-- Paste and execute this script inside your Supabase SQL Editor.

-- 1. Add latitude and longitude columns to public.cities table
ALTER TABLE public.cities 
ADD COLUMN IF NOT EXISTS latitude double precision,
ADD COLUMN IF NOT EXISTS longitude double precision;

-- 2. Notify PostgREST to reload the schema cache immediately
NOTIFY pgrst, 'reload schema';
