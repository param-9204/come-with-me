-- ── MIGRATION V10: Add Status Tracking to Social Posts Table ──
-- Paste and execute this script inside your Supabase SQL Editor.

-- 1. Add status and error_message columns to public.social_posts table
ALTER TABLE public.social_posts 
ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS error_message text;

-- 2. Notify PostgREST to reload the schema cache immediately
NOTIFY pgrst, 'reload schema';
