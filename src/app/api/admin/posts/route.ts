import { NextResponse } from 'next/server';

import { getAdminPostPage, parseAdminPostFilters } from '@/lib/admin-posts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Returns the light-weight data used by the /admin post directory.
 * Accepts limit/offset plus the same filters as the /admin URL
 * (q, status, platform, type, user, from, to, sort, dir).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get('limit') || '15', 10);
  const offset = Number.parseInt(searchParams.get('offset') || '0', 10);
  const filters = parseAdminPostFilters(
    Object.fromEntries(searchParams.entries()),
    Number.isFinite(limit) ? limit : 15,
  );
  const result = await getAdminPostPage({
    ...filters,
    limit: Number.isFinite(limit) ? limit : 15,
    offset: Number.isFinite(offset) ? offset : 0,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ success: true, ...result });
}
