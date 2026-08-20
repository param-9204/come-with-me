import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  request: Request,
  props: { params: any }
) {
  try {
    const params = await props.params;
    const id = params?.id;

    if (!id) {
      return NextResponse.json({ error: 'Missing place ID parameter' }, { status: 400 });
    }

    // 1. Fetch place details
    const { data: place, error: placeError } = await supabaseAdmin
      .from('places')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (placeError) {
      console.error('[Place Details API] Fetch place error:', placeError);
      return NextResponse.json({ error: placeError.message }, { status: 500 });
    }

    if (!place) {
      // Fallback: Query places by social_post_id = id
      const { data: placesByPost, error: postPlacesError } = await supabaseAdmin
        .from('places')
        .select('*')
        .eq('social_post_id', id);

      if (postPlacesError) {
        console.error('[Place Details API] Fetch places by post ID error:', postPlacesError);
        return NextResponse.json({ error: postPlacesError.message }, { status: 500 });
      }

      if (!placesByPost || placesByPost.length === 0) {
        return NextResponse.json({ error: 'Place or Social Post not found' }, { status: 404 });
      }

      // Enrich places with creator details
      const userIds = [...new Set(placesByPost.map((p) => p.user_id).filter(Boolean))];
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

      const enrichedPlaces = placesByPost.map((p) => ({
        ...p,
        created_by: p.user_id ? (profilesMap[p.user_id] || 'Anonymous') : 'Anonymous',
      }));

      return NextResponse.json({
        success: true,
        message: 'Places for social post retrieved successfully',
        places: enrichedPlaces,
      });
    }

    // Retrieve creator details from profiles table
    let createdBy = 'Anonymous';
    if (place.user_id) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('display_name')
        .eq('id', place.user_id)
        .maybeSingle();
      if (profile?.display_name) {
        createdBy = profile.display_name;
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Place details retrieved successfully',
      place: {
        ...place,
        created_by: createdBy,
      },
      created_by: createdBy,
    });
  } catch (error: any) {
    console.error('[Place Details API] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
