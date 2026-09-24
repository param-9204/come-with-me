-- Paste this into Supabase SQL Editor after migration_v27_social_post_trace.sql.
-- Replace the value with the post's exact short_code.
SELECT jsonb_pretty(public.get_social_post_trace('YOUR_SHORT_CODE')) AS social_post_trace;
