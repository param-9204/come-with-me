import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/cities
 *
 * Query params:
 *   search      - filter city names (case-insensitive partial match)
 *   sort_order  - asc | desc (default: asc)
 *   page        - page number, 1-indexed (default: 1)
 *   limit       - results per page, max 200 (default: 50)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // ── Pagination ──────────────────────────────────────────────────
    const limit  = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
    const page   = Math.max(parseInt(searchParams.get('page')  ?? '1',  10), 1);
    const offset = (page - 1) * limit;

    // ── Sorting ─────────────────────────────────────────────────────
    const ascending = (searchParams.get('sort_order') ?? 'asc') === 'asc';

    // ── Filters ─────────────────────────────────────────────────────
    const search = searchParams.get('search')?.trim() ?? '';

    // ── Build query ─────────────────────────────────────────────────
    let query = supabaseAdmin
      .from('cities')
      .select('id, name, created_at', { count: 'exact' })
      .order('name', { ascending })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike('name', `%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[Cities API] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const cities = (data ?? []).map((item: any) => item.name);
    const totalItems = count ?? 0;
    const totalPages = Math.ceil(totalItems / limit);

    return NextResponse.json({
      success: true,
      cities,
      pagination: {
        page,
        limit,
        total_items: totalItems,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1,
      },
    });
  } catch (error: any) {
    console.error('[Cities API] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
