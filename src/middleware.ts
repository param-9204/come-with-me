import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@clerk/backend';
import { v5 as uuidv5 } from 'uuid';
import { createClient } from '@supabase/supabase-js';

const CLERK_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

// Public endpoints that don't need authentication checks
const PUBLIC_PATHS = [
  '/api/webhooks',
  '/api/waitlist',
  '/api/logs/write'
];

export async function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '127.0.0.1';
  const userAgent = request.headers.get('user-agent') || 'Unknown';

  // 1. Skip auth checks for explicitly public paths
  const isPublicPath = PUBLIC_PATHS.some((path) => pathname.startsWith(path));

  // /api/places (GET) is public unless filtering by personal elements
  const isPlacesGet = pathname === '/api/places' && request.method === 'GET';
  const isPersonalPlacesFilter = searchParams.get('my_places') === 'true' || searchParams.get('friends_places') === 'true';
  const isPublicPlacesQuery = isPlacesGet && !isPersonalPlacesFilter;

  const authHeader = request.headers.get('authorization');
  let userId: string | null = null;
  let userEmail: string | null = null;

  // 2. Validate token if present
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];

    // Try Clerk Verification
    try {
      const secretKey = process.env.CLERK_SECRET_KEY;
      if (secretKey) {
        const verified = await verifyToken(token, { secretKey });
        const clerkId = verified.sub;
        if (clerkId) {
          userId = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
          userEmail = (verified as any).email || null;
        }
      }
    } catch (clerkError: any) {
      // Clerk failed, try Supabase fallback
      try {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
        const { data: { user: sbUser }, error: sbError } = await supabase.auth.getUser(token);
        if (!sbError && sbUser) {
          userId = sbUser.id;
          userEmail = sbUser.email || null;
        }
      } catch (sbError: any) {
        console.debug('[Middleware Auth] Supabase token check failed:', sbError.message);
      }
    }
  }

  // 3. Reject unauthenticated requests for protected routes
  const isProtectedRoute = pathname.startsWith('/api/') && !isPublicPath && !isPublicPlacesQuery;
  if (isProtectedRoute && !userId) {
    return NextResponse.json(
      { error: 'Unauthorized. Authenticated session required.' },
      { status: 401 }
    );
  }

  // 4. Clone headers and inject user parameters
  const requestHeaders = new Headers(request.headers);
  if (userId) {
    requestHeaders.set('x-user-id', userId);
  }
  if (userEmail) {
    requestHeaders.set('x-user-email', userEmail);
  }

  // 5. Execute downstream route handler to capture the response status
  const response = await NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // 6. Log request & response status in the background (fire-and-forget)
  if (pathname !== '/api/logs/write') {
    let origin = request.nextUrl.origin;
    const hostHeader = request.headers.get('host') || '';
    if (hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1')) {
      origin = `http://${hostHeader}`;
    } else {
      // For proxies (like ngrok), route internally directly to local development port
      origin = 'http://127.0.0.1:3000';
    }

    fetch(`${origin}/api/logs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method,
        path: pathname,
        userId,
        ip,
        userAgent,
        status: response.status
      })
    }).catch((err) => {
      console.error('[Middleware Logging Failure]', err.message);
    });
  }

  return response;
}

// Intercept all routes matching /api/*
export const config = {
  matcher: '/api/:path*',
};
