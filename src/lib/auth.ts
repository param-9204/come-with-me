import { createClient } from '@supabase/supabase-js';
import { auth } from '@clerk/nextjs/server';
import { verifyToken } from '@clerk/backend';
import { v5 as uuidv5 } from 'uuid';

// A static namespace UUID for deterministic UUID v5 generation.
const CLERK_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

/**
 * Authenticates the request using Clerk's Server SDK or custom headers.
 * Accepts session_tokens, oauth_tokens, and api_keys.
 */
export async function getAuthUser(request?: Request) {
  // 1. Direct Bearer token validation (for mobile/API clients sending Clerk or Supabase tokens)
  if (request) {
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];

      // A. Try Clerk Direct JWT Token Verification first
      try {
        const secretKey = process.env.CLERK_SECRET_KEY;
        if (secretKey) {
          const verified = await verifyToken(token, { secretKey });
          const clerkId = verified.sub;
          if (clerkId) {
            const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
            const email = (verified as any).email || null;
            return {
              id: userUuid,
              clerkId,
              email,
              tokenType: 'clerk_jwt'
            };
          }
        }
      } catch (clerkError: any) {
        console.debug('[Auth] Direct Clerk JWT verification failed:', clerkError.message);
      }

      // B. Try Supabase direct token verification fallback
      try {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) {
          return {
            id: user.id,
            clerkId: null,
            email: user.email || null,
            tokenType: 'supabase_token'
          };
        }
      } catch (supabaseError: any) {
        console.debug('[Auth] Supabase token fallback validation failed:', supabaseError.message);
      }
    }
  }

  // 2. Next.js Server SDK auth() helper (fallback for cookie-based web requests)
  try {
    const authObject = await auth({
      acceptsToken: ['session_token', 'oauth_token', 'api_key'],
    });

    if (authObject.isAuthenticated) {
      const clerkId = authObject.tokenType === 'api_key' ? authObject.subject : authObject.userId;
      if (clerkId) {
        const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
        const email = (authObject as any).sessionClaims?.email as string || null;
        return {
          id: userUuid,
          clerkId,
          email,
          tokenType: authObject.tokenType
        };
      }
    }
  } catch (clerkError: any) {
    console.debug('[Auth] Clerk auth() helper verification failed or skipped:', clerkError.message);
  }

  return null;
}
