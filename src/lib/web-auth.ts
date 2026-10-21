import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

export const WEB_AUTH_COOKIE_NAME = 'web_auth_session';

/**
 * Encodes the secret key into bytes for jose.
 */
function getAuthSecret(): Uint8Array {
  const secret =
    process.env.WEB_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    'come-with-me-scout-intelligence-secret-auth-key-2026';
  return new TextEncoder().encode(secret);
}

/**
 * Returns expected credentials configured in environment variables.
 */
export function getExpectedWebCredentials() {
  const email =
    process.env.WEB_AUTH_EMAIL ||
    process.env.WEB_ADMIN_EMAIL ||
    process.env.ADMIN_EMAIL ||
    'admin@example.com';
  const password =
    process.env.WEB_AUTH_PASSWORD ||
    process.env.WEB_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    'adminpassword123';

  return {
    email: email.trim(),
    password,
  };
}

/**
 * Validates provided credentials against env variables.
 */
export function validateWebCredentials(
  emailInput?: string | null,
  passwordInput?: string | null
): { valid: boolean; email?: string; error?: string } {
  if (!emailInput || !passwordInput) {
    return { valid: false, error: 'Email and password are required.' };
  }

  const { email, password } = getExpectedWebCredentials();

  const normalizedInput = emailInput.trim().toLowerCase();
  const normalizedExpected = email.trim().toLowerCase();

  if (normalizedInput !== normalizedExpected || passwordInput !== password) {
    return { valid: false, error: 'Invalid email or password.' };
  }

  return { valid: true, email };
}

/**
 * Creates a signed JWT for the web session.
 */
export async function createWebSessionToken(
  email: string,
  rememberMe: boolean = false
): Promise<{ token: string; maxAge: number }> {
  const secret = getAuthSecret();
  // 30 days if rememberMe, otherwise 7 days
  const maxAge = rememberMe ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 7;
  const expDuration = rememberMe ? '30d' : '7d';

  const token = await new SignJWT({
    email,
    role: 'admin',
    iss: 'come-with-me-intelligence',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expDuration)
    .sign(secret);

  return { token, maxAge };
}

export interface WebSessionPayload {
  email: string;
  role: string;
  issuedAt?: number;
  expiresAt?: number;
}

/**
 * Verifies a web session JWT token.
 */
export async function verifyWebSessionToken(
  token?: string | null
): Promise<WebSessionPayload | null> {
  if (!token) return null;

  try {
    const secret = getAuthSecret();
    const { payload } = await jwtVerify(token, secret);

    if (payload && typeof payload.email === 'string') {
      return {
        email: payload.email,
        role: (payload.role as string) || 'admin',
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads and verifies the web session from incoming request cookies.
 * Suitable for Next.js Middleware/Proxy or API Route handlers.
 */
export async function getWebSessionFromRequest(
  request: Request | NextRequest
): Promise<WebSessionPayload | null> {
  let token: string | undefined;

  if ('cookies' in request && typeof (request as any).cookies?.get === 'function') {
    token = (request as NextRequest).cookies.get(WEB_AUTH_COOKIE_NAME)?.value;
  } else {
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(
      new RegExp(`(?:^|;\\s*)${WEB_AUTH_COOKIE_NAME}=([^;]+)`)
    );
    token = match ? decodeURIComponent(match[1]) : undefined;
  }

  return await verifyWebSessionToken(token);
}

/**
 * Reads and verifies the web session in Server Components and Layouts.
 */
export async function getWebSessionFromCookies(): Promise<WebSessionPayload | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(WEB_AUTH_COOKIE_NAME)?.value;
    return await verifyWebSessionToken(token);
  } catch {
    return null;
  }
}
