import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyWebSessionToken, WEB_AUTH_COOKIE_NAME } from '@/lib/web-auth';

/**
 * Next.js Proxy (middleware).
 *
 * Handles:
 * 1. Web side authentication: protects '/' and '/admin/*' routes,
 *    redirecting unauthenticated users to '/login'.
 * 2. Mobile/API authentication: wraps clerkMiddleware so that auth() works
 *    inside any route handler when a Clerk Bearer token or session cookie is present.
 */
export default clerkMiddleware(async (clerkAuth, request: NextRequest) => {
  const { pathname } = request.nextUrl;

  const ip =
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';
  const userAgent = request.headers.get('user-agent') || 'Unknown';

  // 1. Bypass Next.js internals, static assets, and images
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.jpeg') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.js')
  ) {
    return NextResponse.next();
  }

  // 2. Bypass Clerk webhooks and Web Auth API routes
  if (pathname.startsWith('/api/webhooks') || pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  // 3. Web Route Protection (Non-API routes)
  const isApiRoute = pathname.startsWith('/api');
  if (!isApiRoute) {
    const sessionToken = request.cookies.get(WEB_AUTH_COOKIE_NAME)?.value;
    const session = await verifyWebSessionToken(sessionToken);

    // If on /login page
    if (pathname === '/login') {
      if (session) {
        const redirectParam = request.nextUrl.searchParams.get('redirect');
        const target =
          redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('/login')
            ? redirectParam
            : '/';
        return NextResponse.redirect(new URL(target, request.url));
      }
      return NextResponse.next();
    }

    // All other web routes (such as '/', '/admin', '/admin/users', etc.) require authentication
    if (!session) {
      const loginUrl = new URL('/login', request.url);
      const destination = pathname + (request.nextUrl.search || '');
      loginUrl.searchParams.set('redirect', destination);
      return NextResponse.redirect(loginUrl);
    }

    return NextResponse.next();
  }

  // 4. API routes: Read auth from Clerk's proxy callback
  const authObject = await clerkAuth();
  const clerkUserId = authObject.userId;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('x-user-id');
  requestHeaders.delete('x-user-clerk-id');
  requestHeaders.delete('x-user-email');

  if (clerkUserId) {
    requestHeaders.set('x-user-id', clerkUserId);
    requestHeaders.set('x-user-clerk-id', clerkUserId);
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // 5. Fire-and-forget request logging
  if (pathname !== '/api/logs/write') {
    let origin = request.nextUrl.origin;
    const hostHeader = request.headers.get('host') || '';
    if (hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1')) {
      origin = `http://${hostHeader}`;
    } else {
      origin = 'http://127.0.0.1:3000';
    }

    fetch(`${origin}/api/logs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method,
        path: pathname,
        userId: clerkUserId || null,
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

// Match all requests except static files
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
