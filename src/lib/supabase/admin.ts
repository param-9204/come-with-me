import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client using the service role key to bypass RLS.
// Use ONLY on the server side (in API routes or Server Actions), and only
// where elevated privileges are explicitly required. Never use this client
// to identify the current authenticated user — see src/lib/auth/current-user.ts.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
