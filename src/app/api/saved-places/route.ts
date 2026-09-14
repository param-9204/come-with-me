import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/auth';

/**
 * GET /api/saved-places
 *
 * Returns the authenticated user's saved places with full search, filter, sort, and pagination.
 *
 * Query params:
 *   search      - full-text search on name, description, neighborhood
 *   category    - filter by exact category (case-insensitive)
 *   city        - filter by city name (partial match)
 *   sort_by     - name | category | city | saved_at (default: saved_at)
 *   sort_order  - asc | desc (default: desc)
 *   page        - 1-indexed page number (default: 1)
 *   limit       - results per page, max 100 (default: 10)
 */
export async function GET(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);

    // ── Pagination ──────────────────────────────────────────────────
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '10', 10), 100);
    const page = Math.max(parseInt(searchParams.get('page') ?? '1', 10), 1);
    const offset = (page - 1) * limit;

    // ── Sorting ─────────────────────────────────────────────────────
    const ALLOWED_SORT = ['name', 'category', 'city', 'saved_at'];
    const sortByParam = searchParams.get('sort_by') ?? 'saved_at';
    const sortBy = ALLOWED_SORT.includes(sortByParam) ? sortByParam : 'saved_at';
    const ascending = (searchParams.get('sort_order') ?? 'desc') === 'asc';

    // ── Filters ─────────────────────────────────────────────────────
    const search = searchParams.get('search')?.trim() ?? '';
    const category = searchParams.get('category')?.trim() ?? '';
    const city = searchParams.get('city')?.trim() ?? '';

    // ── Fetch saved place IDs for user ──────────────────────────────
    const { data: savedEntries, error: savedError, count } = await supabaseAdmin
      .from('saved_places')
      .select('created_at, place_id, social_post_id', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending })
      .range(offset, offset + limit - 1);

    if (savedError) {
      console.error('[Saved Places GET] Query error:', savedError);
      return NextResponse.json({ error: savedError.message }, { status: 500 });
    }

    if (!savedEntries || savedEntries.length === 0) {
      return NextResponse.json({
        success: true,
        places: [],
        pagination: { page, limit, total_items: 0, total_pages: 0, has_next: false, has_prev: false },
      });
    }

    const placeIds = savedEntries.map((e: any) => e.place_id).filter(Boolean);
    const savedAtMap: Record<string, string> = Object.fromEntries(
      savedEntries.map((e: any) => [e.place_id, e.created_at])
    );
    const socialPostIdMap: Record<string, string | null> = Object.fromEntries(
      savedEntries.map((e: any) => [e.place_id, e.social_post_id || null])
    );

    // ── Fetch full place details ─────────────────────────────────────
    let placesQuery = supabaseAdmin
      .from('places')
      .select('*')
      .in('id', placeIds);

    if (search) {
      placesQuery = placesQuery.or(
        `name.ilike.%${search}%,description.ilike.%${search}%,neighborhood.ilike.%${search}%`
      );
    }
    if (category && category.toUpperCase() !== 'ALL') placesQuery = placesQuery.ilike('category', category);
    if (city) placesQuery = placesQuery.ilike('city', `%${city}%`);

    // Sort by place columns if not sorting by saved_at
    if (sortBy !== 'saved_at') {
      placesQuery = placesQuery.order(sortBy, { ascending });
    }

    const { data: places, error: placesError } = await placesQuery;

    if (placesError) {
      console.error('[Saved Places GET] Places fetch error:', placesError);
      return NextResponse.json({ error: placesError.message }, { status: 500 });
    }

    // ── Enrich with creator details dynamically ──────────────────────
    let placeCreatorsMap: Record<string, { creator_handle: string; post_url: string; platform: string }[]> = {};

    if (placeIds.length > 0) {
      const { data: junctionData } = await supabaseAdmin
        .from('social_post_places')
        .select('place_id, social_posts(author_username, post_url, platform)')
        .in('place_id', placeIds);

      if (junctionData) {
        junctionData.forEach((row: any) => {
          const pId = row.place_id;
          const post = row.social_posts;
          if (pId && post?.author_username) {
            let handle = post.author_username.trim();
            if (!handle.startsWith('@')) handle = `@${handle}`;

            if (!placeCreatorsMap[pId]) {
              placeCreatorsMap[pId] = [];
            }
            if (!placeCreatorsMap[pId].some((c) => c.creator_handle === handle)) {
              placeCreatorsMap[pId].push({
                creator_handle: handle,
                post_url: post.post_url || '',
                platform: post.platform || '',
              });
            }
          }
        });
      }
    }

    const enrichedPlaces = (places ?? []).map((p) => {
      const creatorsList = placeCreatorsMap[p.id] || [];
      const effectiveHandle = creatorsList.length > 0 ? creatorsList[0].creator_handle : null;
      const rawAuthorUsername = effectiveHandle ? effectiveHandle.replace(/^@/, '') : null;

      return {
        ...p,
        social_post_id: socialPostIdMap[p.id] ?? null,
        saved_at: savedAtMap[p.id] ?? null,
        author_username: rawAuthorUsername,
        creator_handle: effectiveHandle,
        creators: creatorsList,
        created_by: effectiveHandle || 'Community',
      };
    });

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
    console.error('[Saved Places GET] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// ── POST: Save/like a place ────────────────────────────────────────────────────
export async function POST(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Authenticated session required.' }, { status: 401 });
    }

    const body = await request.json();
    const { placeId, socialPostId, social_post_id } = body;
    const finalSocialPostId = socialPostId || social_post_id || null;

    if (!placeId) {
      return NextResponse.json({ error: 'Missing required field: placeId' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('saved_places')
      .insert({
        user_id: user.id,
        place_id: placeId,
        social_post_id: finalSocialPostId,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ success: true, message: 'Place already saved' });
      }
      console.error('[Saved Places POST] Insert error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Place saved successfully', id: data?.id });
  } catch (error: any) {
    console.error('[Saved Places POST] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE: Remove a saved place ──────────────────────────────────────────────
export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Authenticated session required.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const placeId = searchParams.get('placeId');

    if (!placeId) {
      return NextResponse.json({ error: 'Missing required parameter: placeId' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('saved_places')
      .delete()
      .eq('user_id', user.id)
      .eq('place_id', placeId);

    if (error) {
      console.error('[Saved Places DELETE] Delete error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Place removed from saved successfully' });
  } catch (error: any) {
    console.error('[Saved Places DELETE] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

