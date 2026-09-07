import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthUser } from '@/lib/auth';

/**
 * Next.js Proxy (formerly middleware).
 *
 * Wraps clerkMiddleware so that auth() works inside any route handler
 * when a Clerk Bearer token or session cookie is present.
 */
export default clerkMiddleware(async (clerkAuth, request: NextRequest) => {
  const { pathname } = request.nextUrl;

  const ip =
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';
  const userAgent = request.headers.get('user-agent') || 'Unknown';

  // 1. Bypass Clerk webhooks
  if (pathname.startsWith('/api/webhooks')) {
    return NextResponse.next();
  }

  // 2. Authenticate and inject x-user-* headers for downstream route handlers
  const user = await getAuthUser(request);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('x-user-id');
  requestHeaders.delete('x-user-clerk-id');
  requestHeaders.delete('x-user-email');

  if (user) {
    requestHeaders.set('x-user-id', user.id);
    requestHeaders.set('x-user-clerk-id', user.clerkId || '');
    requestHeaders.set('x-user-email', user.email || '');
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // 3. Fire-and-forget request logging
  if (pathname !== '/api/logs/write') {
    let origin = request.nextUrl.origin;
    const hostHeader = request.headers.get('host') || '';
    if (hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1')) {
      origin = `http://${hostHeader}`;
    } else {
      // For proxies (like ngrok), route internally to local dev port
      origin = 'http://127.0.0.1:3000';
    }

    fetch(`${origin}/api/logs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method,
        path: pathname,
        userId: user?.id || null,
        ip,
        userAgent,
        status: response.status,
      }),
    }).catch((err) => {
      console.error('[Proxy Logging Failure]', err.message);
    });
  }

  return response;
});

// Target all API endpoints
export const config = {
  matcher: '/api/:path*',
};
