import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/auth';

/**
 * GET /api/places
 *
 * Query params:
 *   search      - full-text search on name, description, neighborhood (case-insensitive)
 *   category    - filter by exact category (case-insensitive)
 *   city        - filter by city name (case-insensitive partial match)
 *   sort_by     - column to sort by: name | category | city | created_at | rating (default: created_at)
 *   sort_order  - asc | desc (default: desc)
 *   page        - page number, 1-indexed (default: 1)
 *   limit       - results per page, max 100 (default: 10)
 *   my_places   - "true" to filter by the authenticated user's own uploads
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // ── Pagination ──────────────────────────────────────────────────
    const limit   = Math.min(parseInt(searchParams.get('limit')  ?? '10', 10), 100);
    const page    = Math.max(parseInt(searchParams.get('page')   ?? '1',  10), 1);
    const offset  = (page - 1) * limit;

    // ── Sorting ─────────────────────────────────────────────────────
    const ALLOWED_SORT = ['name', 'category', 'city', 'created_at', 'rating'];
    const sortBy    = ALLOWED_SORT.includes(searchParams.get('sort_by') ?? '') ? searchParams.get('sort_by')! : 'created_at';
    const ascending = (searchParams.get('sort_order') ?? 'desc') === 'asc';

    // ── Filters ─────────────────────────────────────────────────────
    const search    = searchParams.get('search')?.trim()   ?? '';
    const category  = searchParams.get('category')?.trim() ?? '';
    const city      = searchParams.get('city')?.trim()     ?? '';
    const myPlaces  = searchParams.get('my_places') === 'true';

    // ── Build query ─────────────────────────────────────────────────
    let query = supabaseAdmin
      .from('places')
      .select('*', { count: 'exact' })
      .order(sortBy, { ascending })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,description.ilike.%${search}%,neighborhood.ilike.%${search}%`
      );
    }

    if (category) query = query.ilike('category', category);
    if (city)     query = query.ilike('city', `%${city}%`);

    if (myPlaces) {
      const user = await getAuthUser(request);
      if (!user) {
        return NextResponse.json(
          { error: 'Unauthorized. Authenticated session required for personal dashboard.' },
          { status: 401 }
        );
      }
      query = query.eq('user_id', user.id);
    }

    const { data: places, error, count } = await query;

    if (error) {
      console.error('[Places API] Query error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ── Enrich with creator display names ───────────────────────────
    const userIds = [...new Set((places ?? []).map((p) => p.user_id).filter(Boolean))];
    let profilesMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds);
      if (profiles) {
        profilesMap = Object.fromEntries(
          profiles.map((p) => [p.id, p.display_name || 'Anonymous'])
        );
      }
    }

    const enrichedPlaces = (places ?? []).map((p) => ({
      ...p,
      created_by: p.user_id ? (profilesMap[p.user_id] || 'Anonymous') : 'Anonymous',
    }));

    const totalItems = count ?? 0;
    const totalPages = Math.ceil(totalItems / limit);

    return NextResponse.json({
      success: true,
      places: enrichedPlaces,
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
    console.error('[Places API] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
