import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { DbService } from '@/lib/services/db.service';

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
      // Fallback: Query places associated with social post ID
      const placesByPost = await DbService.getPlacesForSocialPost(id);

      if (!placesByPost || placesByPost.length === 0) {
        return NextResponse.json({ error: 'Place or Social Post not found' }, { status: 404 });
      }

      const enrichedPlaces = placesByPost.map((p) => ({
        ...p,
        created_by: 'Community',
      }));

      return NextResponse.json({
        success: true,
        message: 'Places for social post retrieved successfully',
        places: enrichedPlaces,
      });
    }

    let createdBy = 'Community';

    // Fetch linked social posts & creator handles for this place
    const { data: junctionData } = await supabaseAdmin
      .from('social_post_places')
      .select('social_posts(author_username, post_url, platform, created_at)')
      .eq('place_id', place.id);

    const creators: { creator_handle: string; post_url: string; platform: string }[] = [];
    if (junctionData) {
      junctionData.forEach((row: any) => {
        const post = row.social_posts;
        if (post?.author_username) {
          let handle = post.author_username.trim();
          if (!handle.startsWith('@')) handle = `@${handle}`;

          if (!creators.some((c) => c.creator_handle === handle)) {
            creators.push({
              creator_handle: handle,
              post_url: post.post_url || '',
              platform: post.platform || '',
            });
          }
        }
      });
    }

    const primaryCreatorHandle = creators.length > 0 ? creators[0].creator_handle : null;

    return NextResponse.json({
      success: true,
      message: 'Place details retrieved successfully',
      place: {
        ...place,
        creator_handle: primaryCreatorHandle,
        creators,
        created_by: createdBy,
      },
      created_by: createdBy,
    });
  } catch (error: any) {
    console.error('[Place Details API] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
