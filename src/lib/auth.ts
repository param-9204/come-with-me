import { createClient } from '@supabase/supabase-js';
import { verifyToken } from '@clerk/backend';
import { v5 as uuidv5 } from 'uuid';

// A static namespace UUID for deterministic UUID v5 generation.
// This maps any Clerk user ID string (e.g. "user_2ND1...") to a unique PostgreSQL UUID.
const CLERK_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

/**
 * Authenticates the request using the Bearer token sent by the client.
 * Supports both Clerk session tokens (used by the mobile app) and Supabase session tokens (backward compatibility).
 * Returns the user object with a valid UUID mapping if authenticated, or null.
 */
export async function getAuthUser(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];

  // 1. Attempt Clerk Token Verification
  try {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (secretKey) {
      const verified = await verifyToken(token, { secretKey });
      const clerkId = verified.sub;
      if (clerkId) {
        // Calculate deterministic UUID based on Clerk ID
        const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
        return {
          id: userUuid,
          clerkId,
          email: (verified as any).email || null,
        };
      }
    }
  } catch (clerkError: any) {
    // If it's a Clerk validation error, log it as debug info
    console.debug('[Auth] Clerk token validation skipped or failed:', clerkError.message);
  }

  // 2. Fallback to Supabase Token Verification
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (!error && user) {
      return user;
    }
  } catch (supabaseError: any) {
    console.error('[Auth] Supabase token fallback validation failed:', supabaseError.message);
  }

  return null;
}
