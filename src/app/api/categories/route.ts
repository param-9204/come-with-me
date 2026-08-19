import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/categories
 *
 * Query params:
 *   search      - filter category names (case-insensitive partial match)
 *   city        - only return categories used in this city
 *   sort_order  - asc | desc (default: asc)
 *   page        - page number, 1-indexed (default: 1)
 *   limit       - results per page, max 100 (default: 50)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // ── Filters ─────────────────────────────────────────────────────
    const search = searchParams.get('search')?.trim() ?? '';
    const city   = searchParams.get('city')?.trim()   ?? '';

    // ── Pagination ──────────────────────────────────────────────────
    const limit  = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);
    const page   = Math.max(parseInt(searchParams.get('page')  ?? '1',  10), 1);

    // ── Sorting ─────────────────────────────────────────────────────
    const ascending = (searchParams.get('sort_order') ?? 'asc') === 'asc';

    // ── Fetch unique categories from places table ────────────────────
    let query = supabaseAdmin
      .from('places')
      .select('category')
      .not('category', 'is', null);

    if (city) {
      query = query.ilike('city', `%${city}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[Categories API] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Deduplicate, clean, and sort
    let categories = Array.from(new Set(data.map((item: any) => item.category)))
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0);

    if (search) {
      categories = categories.filter((c) =>
        c.toLowerCase().includes(search.toLowerCase())
      );
    }

    categories = ascending ? categories.sort() : categories.sort().reverse();

    // Apply pagination in-memory (categories are typically < 50, so this is fine)
    const totalItems = categories.length;
    const totalPages = Math.ceil(totalItems / limit);
    const start = (page - 1) * limit;
    const paged = categories.slice(start, start + limit);

    return NextResponse.json({
      success: true,
      categories: paged,
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
    console.error('[Categories API] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
