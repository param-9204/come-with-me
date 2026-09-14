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
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '10', 10), 100);
    const page = Math.max(parseInt(searchParams.get('page') ?? '1', 10), 1);
    const offset = (page - 1) * limit;

    // ── Sorting ─────────────────────────────────────────────────────
    const ALLOWED_SORT = ['name', 'category', 'city', 'created_at', 'rating'];
    const sortBy = ALLOWED_SORT.includes(searchParams.get('sort_by') ?? '') ? searchParams.get('sort_by')! : 'created_at';
    const ascending = (searchParams.get('sort_order') ?? 'desc') === 'asc';

    // ── Filters ─────────────────────────────────────────────────────
    const search = searchParams.get('search')?.trim() ?? '';
    const category = searchParams.get('category')?.trim() ?? '';
    const city = searchParams.get('city')?.trim() ?? '';
    const socialPostId = searchParams.get('social_post_id')?.trim() ?? '';
    const myPlaces = searchParams.get('my_places') === 'true';

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

    if (category && category.toUpperCase() !== 'ALL') query = query.ilike('category', category);
    if (city) query = query.ilike('city', `%${city}%`);
    let postAuthorHandle: string | null = null;
    if (socialPostId) {
      const { data: postData } = await supabaseAdmin
        .from('social_posts')
        .select('author_username')
        .eq('id', socialPostId)
        .maybeSingle();

      if (postData?.author_username) {
        const handle = postData.author_username.trim();
        postAuthorHandle = handle.startsWith('@') ? handle : `@${handle}`;
      }

      const { data: junctionRows } = await supabaseAdmin
        .from('social_post_places')
        .select('place_id')
        .eq('social_post_id', socialPostId);
      const placeIds = junctionRows?.map((r) => r.place_id).filter(Boolean) || [];

      if (placeIds.length > 0) {
        query = query.in('id', placeIds);
      } else {
        // Return no results if socialPostId has no linked places
        query = query.eq('id', '00000000-0000-0000-0000-000000000000');
      }
    }

    if (myPlaces) {
      const user = await getAuthUser(request);
      if (!user) {
        return NextResponse.json(
          { error: 'Unauthorized. Authenticated session required for personal dashboard.' },
          { status: 401 }
        );
      }

      const { data: userPosts } = await supabaseAdmin
        .from('social_posts')
        .select('id')
        .eq('user_id', user.id);

      const userPostIds = userPosts?.map((p) => p.id) || [];

      if (userPostIds.length > 0) {
        const { data: userJunction } = await supabaseAdmin
          .from('social_post_places')
          .select('place_id')
          .in('social_post_id', userPostIds);

        const myPlaceIds = [...new Set(userJunction?.map((j) => j.place_id).filter(Boolean))];
        if (myPlaceIds.length > 0) {
          query = query.in('id', myPlaceIds);
        } else {
          query = query.eq('id', '00000000-0000-0000-0000-000000000000');
        }
      } else {
        query = query.eq('id', '00000000-0000-0000-0000-000000000000');
      }
    }

    const { data: places, error, count } = await query;

    if (error) {
      console.error('[Places API] Query error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ── Fetch creator handles dynamically from social_post_places -> social_posts ──
    const fetchedPlaceIds = (places ?? []).map((p) => p.id).filter(Boolean);
    let placeCreatorsMap: Record<string, { creator_handle: string; post_url: string; platform: string }[]> = {};

    if (fetchedPlaceIds.length > 0) {
      const { data: junctionData } = await supabaseAdmin
        .from('social_post_places')
        .select('place_id, social_posts(author_username, post_url, platform)')
        .in('place_id', fetchedPlaceIds);

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

    const handles = Array.from(
      new Set(
        (places ?? [])
          .flatMap((p) => {
            const creators = placeCreatorsMap[p.id] || [];
            return postAuthorHandle
              ? [postAuthorHandle]
              : creators.map((c) => c.creator_handle);
          })
          .filter(Boolean)
      )
    );
    const avatarMap = new Map<string, string>();

    if (handles.length > 0) {
      const cleanHandles = handles.map((h: string) => (h.startsWith('@') ? h.slice(1) : h));
      const { data: matchedProfiles } = await supabaseAdmin
        .from('profiles')
        .select('display_name, avatar_url')
        .or(`display_name.in.(${cleanHandles.join(',')}),clerk_user_id.in.(${handles.join(',')})`);

      (matchedProfiles || []).forEach((prof: any) => {
        if (prof.avatar_url) {
          if (prof.display_name) avatarMap.set(`@${prof.display_name.toLowerCase()}`, prof.avatar_url);
          if (prof.display_name) avatarMap.set(prof.display_name.toLowerCase(), prof.avatar_url);
        }
      });
    }

    const enrichedPlaces = (places ?? []).map((p) => {
      const creatorsList = placeCreatorsMap[p.id] || [];
      const effectiveHandle = postAuthorHandle || (creatorsList.length > 0 ? creatorsList[0].creator_handle : null);
      const handleKey = (effectiveHandle || '').toLowerCase();
      const avatar = avatarMap.get(handleKey) || null;
      const rawAuthorUsername = effectiveHandle ? effectiveHandle.replace(/^@/, '') : null;

      return {
        ...p,
        author_username: rawAuthorUsername,
        creator_handle: effectiveHandle,
        creators: creatorsList,
        created_by: effectiveHandle || 'Community',
        creator_avatar: avatar,
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
    console.error('[Places API] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
