import { NextResponse } from 'next/server';

import { getAdminPostPage } from '@/lib/admin-posts';

/** Returns the light-weight data used by the /admin post directory. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get('limit') || '15', 10);
  const offset = Number.parseInt(searchParams.get('offset') || '0', 10);
  const result = await getAdminPostPage({
    limit: Number.isFinite(limit) ? limit : 15,
    offset: Number.isFinite(offset) ? offset : 0,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ success: true, ...result });
}
