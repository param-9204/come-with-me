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
      return NextResponse.json({ error: 'Place not found' }, { status: 404 });
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
