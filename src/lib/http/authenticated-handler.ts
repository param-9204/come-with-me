import { NextRequest } from 'next/server';

import { requireUser } from '@/lib/auth/require-user';
import type { AuthenticatedUser } from '@/lib/auth/current-user';

import { withApiHandler, type ApiContext } from './handler';

export interface AuthenticatedApiContext extends ApiContext {
  user: AuthenticatedUser;
}

type AuthenticatedApiHandler<RouteProps> = (
  request: NextRequest,
  context: AuthenticatedApiContext,
  routeProps: RouteProps
) => Promise<Response>;

/**
 * Wraps a route handler so it never executes for an unauthenticated request.
 * requireUser() runs before the handler and throws a 401 ApiError (handled
 * by withApiHandler) if the bearer token is missing/malformed/invalid.
 */
export function withAuthenticatedHandler<RouteProps = { params: Promise<Record<string, string>> }>(
  handler: AuthenticatedApiHandler<RouteProps>,
  options?: { name?: string }
) {
  return withApiHandler<RouteProps>(async (request, context, routeProps) => {
    const user = await requireUser(request);
    return handler(request, { ...context, user }, routeProps);
  }, options);
}
