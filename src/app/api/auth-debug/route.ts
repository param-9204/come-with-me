import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';

/**
 * GET/POST /api/auth-debug
 *
 * Temporary debug endpoint to verify that a Clerk Bearer token is accepted.
 * Call from the mobile app with:
 *   Authorization: Bearer <clerkToken>
 *
 * Returns the resolved user ID if auth succeeds, or 401 with details if it fails.
 * DELETE THIS FILE before going to production.
 */
export async function GET(request: Request) {
  return handleDebug(request);
}

export async function POST(request: Request) {
  return handleDebug(request);
}

async function handleDebug(request: Request) {
  const authHeader = request.headers.get('authorization');
  const xUserId = request.headers.get('x-user-id'); // Set by middleware if auth worked there

  console.log('[AuthDebug] authHeader present:', !!authHeader);
  console.log('[AuthDebug] x-user-id from middleware:', xUserId);

  const user = await getAuthUser(request);

  if (!user) {
    return NextResponse.json(
      {
        success: false,
        error: 'Auth failed – check server logs for the exact reason',
        debug: {
          authHeaderPresent: !!authHeader,
          authHeaderPrefix: authHeader?.substring(0, 30),
          xUserIdFromMiddleware: xUserId,
          clerkSecretKeySet: !!process.env.CLERK_SECRET_KEY,
          clerkPublishableKeySet: !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        },
      },
      { status: 401 }
    );
  }

  return NextResponse.json({
    success: true,
    user: {
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      tokenType: user.tokenType,
    },
    debug: {
      xUserIdFromMiddleware: xUserId,
    },
  });
}
