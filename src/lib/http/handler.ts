import { NextRequest } from 'next/server';

import { ApiError } from './errors';
import { errorResponse } from './response';
import { logger } from '@/lib/logger';

export interface ApiContext {
  requestId: string;
}

// Response (not NextResponse) so streaming routes (e.g. SSE via
// `new Response(stream, {...})`) can also be wrapped — NextResponse.json()
// results remain assignable since NextResponse extends Response.
type ApiHandler<RouteProps> = (
  request: NextRequest,
  context: ApiContext,
  routeProps: RouteProps
) => Promise<Response>;

export function withApiHandler<RouteProps = { params: Promise<Record<string, string>> }>(
  handler: ApiHandler<RouteProps>,
  options?: {
    name?: string;
  }
) {
  // The second parameter is Next.js's dynamic-route `{ params }` object; it
  // is undefined for routes with no dynamic segments and forwarded as-is
  // otherwise, so handlers for [id]-style routes can still read it.
  return async (request: NextRequest, routeProps: RouteProps) => {
    const start = Date.now();

    const requestId =
      request.headers.get('x-request-id') ??
      crypto.randomUUID();

    const name =
      options?.name ??
      `${request.method} ${request.nextUrl.pathname}`;

    logger.info('api_request_started', {
      requestId,
      method: request.method,
      path: request.nextUrl.pathname,
      api: name,
    });

    try {
      const response = await handler(
        request,
        { requestId },
        routeProps
      );

      const durationMs = Date.now() - start;

      logger.info('api_request_completed', {
        requestId,
        method: request.method,
        path: request.nextUrl.pathname,
        api: name,
        status: response.status,
        durationMs,
      });

      response.headers.set('x-request-id', requestId);

      return response;
    } catch (error) {
      const durationMs = Date.now() - start;

      if (error instanceof ApiError) {
        logger.warn('api_request_failed', {
          requestId,
          method: request.method,
          path: request.nextUrl.pathname,
          api: name,
          status: error.statusCode,
          durationMs,
          code: error.code,
        });

        return errorResponse(
          error.message,
          error.statusCode,
          error.code
        );
      }

      logger.error('api_request_unhandled_error', {
        requestId,
        method: request.method,
        path: request.nextUrl.pathname,
        api: name,
        status: 500,
        durationMs,
        error,
      });

      return errorResponse(
        'Internal server error',
        500,
        'INTERNAL_SERVER_ERROR'
      );
    }
  };
}