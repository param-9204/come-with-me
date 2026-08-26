import { createClient } from '@supabase/supabase-js';
import { auth } from '@clerk/nextjs/server';
import { verifyToken } from '@clerk/backend';
import { v5 as uuidv5 } from 'uuid';
import * as jwt from 'jsonwebtoken';

// A static namespace UUID for deterministic UUID v5 generation.
const CLERK_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

/**
 * Decode a JWT and extract the issuer claim without verifying the signature.
 * Used to find the correct Clerk JWKS endpoint for a token from a different instance.
 */
function decodeTokenIssuer(token: string): string | null {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;
    return decoded?.payload?.iss || null;
  } catch {
    return null;
  }
}

/**
 * Authenticates the request using Clerk's Server SDK or custom headers.
 *
 * Priority:
 *   1. Clerk Bearer JWT  (mobile / API clients) — handles cross-instance tokens
 *   2. Clerk auth() helper (cookie-based web requests)
 *   3. Supabase JWT fallback
 */
export async function getAuthUser(request?: Request) {
  // ─── 1. Direct Bearer token from Authorization header ───────────────────────
  if (request) {
    const authHeader = request.headers.get('authorization');
    console.log('[Auth] Authorization header present:', !!authHeader);

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      console.log('[Auth] Bearer token length:', token?.length, '| prefix:', token?.substring(0, 20));

      const secretKey = process.env.CLERK_SECRET_KEY;
      if (!secretKey) {
        console.error('[Auth] CLERK_SECRET_KEY is missing from environment!');
      } else {
        // A. First try with the server's configured secret key
        try {
          const verified = await verifyToken(token, {
            secretKey,
            authorizedParties: [],
          });
          const clerkId = verified.sub;
          if (clerkId) {
            const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
            const email = (verified as any).email || (verified as any)?.sessionClaims?.email || null;
            console.log('[Auth] ✅ Clerk JWT verified (primary key). clerkId:', clerkId);
            return {
              id: userUuid,
              clerkId,
              email,
              tokenType: 'clerk_jwt' as const,
            };
          }
        } catch (clerkError: any) {
          console.error('[Auth] ❌ Clerk JWT verification failed (primary key):', clerkError.message);

          // B. JWKS kid mismatch — the mobile token may come from a different Clerk instance.
          //    Decode the token issuer and fetch JWKS directly from that instance.
          //    This handles test-instance vs live-instance token mismatch.
          const issuer = decodeTokenIssuer(token);
          console.log('[Auth] Token issuer (iss):', issuer);

          if (issuer && issuer.includes('clerk')) {
            try {
              // verifyToken accepts jwtKey as a raw JWKS URL or a PEM,
              // but the cleanest cross-instance approach is: fetch JWKS from the issuer.
              const jwksUrl = `${issuer}/.well-known/jwks.json`;
              console.log('[Auth] Fetching JWKS from:', jwksUrl);

              const jwksRes = await fetch(jwksUrl);
              if (jwksRes.ok) {
                const jwks = await jwksRes.json();
                // Use the raw JWKS JSON string as jwtKey (Clerk backend supports this)
                const verified = await verifyToken(token, {
                  jwtKey: JSON.stringify(jwks),
                  authorizedParties: [],
                });
                const clerkId = verified.sub;
                if (clerkId) {
                  const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
                  const email = (verified as any).email || (verified as any)?.sessionClaims?.email || null;
                  console.log('[Auth] ✅ Clerk JWT verified (cross-instance JWKS). clerkId:', clerkId);
                  return {
                    id: userUuid,
                    clerkId,
                    email,
                    tokenType: 'clerk_jwt' as const,
                  };
                }
              } else {
                console.error('[Auth] Failed to fetch JWKS from issuer:', jwksRes.status);
              }
            } catch (crossErr: any) {
              console.error('[Auth] ❌ Cross-instance Clerk JWT verification failed:', crossErr.message);
            }
          }
        }
      }

      // C. Supabase JWT fallback (if mobile uses Supabase Auth)
      try {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) {
          console.log('[Auth] ✅ Supabase JWT verified. userId:', user.id);
          return {
            id: user.id,
            clerkId: null,
            email: user.email || null,
            tokenType: 'supabase_token' as const,
          };
        }
        if (error) {
          console.error('[Auth] Supabase fallback failed:', error.message);
        }
      } catch (supabaseError: any) {
        console.error('[Auth] Supabase fallback exception:', supabaseError.message);
      }

      // Bearer token present but all methods failed — don't fall through to cookie auth
      console.error('[Auth] ❌ Bearer token failed all verification. Returning null.');
      return null;
    }
  }

  // ─── 2. Clerk auth() helper (cookie-based web session) ───────────────────────
  try {
    const authObject = await auth({
      acceptsToken: ['session_token', 'oauth_token', 'api_key'],
    });

    if (authObject.isAuthenticated) {
      const clerkId = authObject.tokenType === 'api_key' ? authObject.subject : authObject.userId;
      if (clerkId) {
        const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
        const email = (authObject as any).sessionClaims?.email as string || null;
        console.log('[Auth] ✅ Clerk auth() helper verified. clerkId:', clerkId);
        return {
          id: userUuid,
          clerkId,
          email,
          tokenType: authObject.tokenType,
        };
      }
    }
  } catch (clerkError: any) {
    console.error('[Auth] Clerk auth() helper failed:', clerkError.message);
  }

  console.error('[Auth] ❌ All auth methods exhausted. Returning null.');
  return null;
}
