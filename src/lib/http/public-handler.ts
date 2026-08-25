import { NextRequest } from 'next/server';

import { withApiHandler, type ApiContext } from './handler';

type PublicApiHandler<RouteProps> = (
  request: NextRequest,
  context: ApiContext,
  routeProps: RouteProps
) => Promise<Response>;

/**
 * Explicit opt-out of authentication for routes that are intentionally
 * public. Functionally equivalent to withApiHandler — the separate name
 * makes the auth requirement obvious from the route file itself.
 */
export function withPublicHandler<RouteProps = { params: Promise<Record<string, string>> }>(
  handler: PublicApiHandler<RouteProps>,
  options?: { name?: string }
) {
  return withApiHandler<RouteProps>(handler, options);
}
