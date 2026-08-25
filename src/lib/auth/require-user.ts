import { unauthorized } from '@/lib/http/errors';
import { logger } from '@/lib/logger';

import { getCurrentUser, type AuthenticatedUser } from './current-user';

/**
 * Extracts and validates the bearer token from the Authorization header.
 * Throws a 401 ApiError for any authentication failure (missing header,
 * non-Bearer scheme, empty/invalid/expired token) — the token itself is
 * never logged.
 */
export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const path = new URL(request.url).pathname;
  const method = request.method;

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    logger.warn('auth_missing_token', { path, method });
    throw unauthorized();
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    logger.warn('auth_invalid_token', { path, method, reason: 'malformed_header' });
    throw unauthorized();
  }

  const user = await getCurrentUser(token);
  if (!user) {
    logger.warn('auth_invalid_token', { path, method });
    throw unauthorized();
  }

  logger.debug('auth_success', { path, method, userId: user.id });
  return user;
}

/**
 * Best-effort variant for routes where authentication is optional: returns
 * the user if a valid bearer token is present, or null otherwise. Never
 * throws for missing/malformed/invalid tokens.
 */
export async function getOptionalUser(request: Request): Promise<AuthenticatedUser | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return getCurrentUser(token);
}
