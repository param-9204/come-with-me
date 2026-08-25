import { verifyToken } from '@clerk/backend';
import { v5 as uuidv5 } from 'uuid';

import { createSupabaseClient } from '@/lib/supabase/server';

// Deterministic namespace used to map a Clerk user ID to a Postgres UUID.
// Must stay identical everywhere a Clerk ID is mapped to a user row
// (also used by src/app/api/webhooks/clerk/route.ts) or user lookups drift.
export const CLERK_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

export function clerkIdToUuid(clerkId: string): string {
  return uuidv5(clerkId, CLERK_UUID_NAMESPACE);
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  clerkId?: string;
}

/**
 * Validates a bearer access token and resolves the authenticated user.
 *
 * The mobile client sends Clerk session tokens, so Clerk verification is
 * tried first; a raw Supabase access token is accepted as a fallback for
 * backward compatibility. This preserves the dual-verification behavior of
 * the previous getAuthUser() helper — it is not a plain
 * supabase.auth.getUser(accessToken)-only check, because that alone would
 * reject every Clerk-issued token currently in use by the mobile app.
 *
 * Returns null on any invalid/expired token; never throws for normal
 * authentication failures (see requireUser() for the 401 boundary).
 */
export async function getCurrentUser(accessToken: string): Promise<AuthenticatedUser | null> {
  if (!accessToken) {
    return null;
  }

  // 1. Clerk session token (primary, mobile app)
  try {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (secretKey) {
      const verified = await verifyToken(accessToken, { secretKey });
      const clerkId = verified.sub;
      if (clerkId) {
        return {
          id: clerkIdToUuid(clerkId),
          clerkId,
          email: (verified as { email?: string }).email ?? null,
        };
      }
    }
  } catch {
    // Not a valid Clerk token — fall through to Supabase verification.
  }

  // 2. Supabase access token (backward compatibility)
  try {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (!error && data.user) {
      return {
        id: data.user.id,
        email: data.user.email ?? null,
      };
    }
  } catch {
    // Invalid/expired Supabase token.
  }

  return null;
}
