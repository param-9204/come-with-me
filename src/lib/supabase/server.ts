import { createClient } from '@supabase/supabase-js';

// Anon-key Supabase client for server-side, per-request use — e.g. validating
// a bearer access token via supabase.auth.getUser(accessToken) in
// src/lib/auth/current-user.ts. This is a backend/API-only project: there is
// no cookie/session state, so this intentionally does not use @supabase/ssr.
export function createSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
