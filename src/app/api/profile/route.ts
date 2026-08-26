import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';

/**
 * GET /api/profile
 *
 * Returns the authenticated user's profile details.
 */
export async function GET(request: Request) {
  try {
    // 1. Authenticate the request using the Bearer token
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const profileId = await resolveProfileId({
      clerkId: user.clerkId,
      userIdInput: user.id,
      email: user.email,
    });

    // 2. Fetch the profile from the database
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', profileId || user.id)
      .maybeSingle();

    if (fetchError) {
      console.error('[Profile GET API] Query error:', fetchError);
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 }
      );
    }

    // 3. Auto-initialize the profile if not found (self-healing fallback)
    if (!profile) {
      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: profileId || user.id,
          clerk_user_id: user.clerkId || undefined,
          display_name: 'Explorer',
        })
        .select('*')
        .single();


      if (insertError) {
        console.error('[Profile GET API] Auto-initialization error:', insertError);
        return NextResponse.json(
          { error: 'Profile not found and failed to initialize.' },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        profile: {
          id: newProfile.id,
          displayName: newProfile.display_name,
          phone: newProfile.phone,
          createdAt: newProfile.created_at,
        },
      });
    }

    // 4. Return profile
    return NextResponse.json({
      success: true,
      profile: {
        id: profile.id,
        displayName: profile.display_name,
        phone: profile.phone,
        createdAt: profile.created_at,
      },
    });
  } catch (error: any) {
    console.error('[Profile GET API] Unhandled exception:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/profile
 *
 * Request Body:
 *   displayName? : string
 *   phone?       : string
 */
export async function PUT(request: Request) {
  try {
    // 1. Authenticate the request using the Bearer token
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const { displayName, phone } = body;

    // 3. Prepare the database update object
    const updateData: Record<string, any> = {};

    // 4. Validate fields and build update object
    if (displayName !== undefined) {
      updateData.display_name = typeof displayName === 'string' ? displayName.trim() : displayName;
    }

    if (phone !== undefined) {
      updateData.phone = typeof phone === 'string' ? phone.trim() : phone;
    }

    // Check if there are fields to update
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields provided for update' },
        { status: 400 }
      );
    }

    const profileId = await resolveProfileId({
      clerkId: user.clerkId,
      userIdInput: user.id,
      email: user.email,
    });

    // 5. Update user profile in database
    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update(updateData)
      .eq('id', profileId || user.id)
      .select('*')
      .maybeSingle();


    if (updateError) {
      console.error('[Profile PUT API] Update error:', updateError);
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 }
      );
    }

    if (!updatedProfile) {
      return NextResponse.json(
        { error: 'Profile not found. Make sure your profile has been initialized.' },
        { status: 404 }
      );
    }

    // 6. Return response
    return NextResponse.json({
      success: true,
      message: 'Profile updated successfully',
      profile: {
        id: updatedProfile.id,
        displayName: updatedProfile.display_name,
        phone: updatedProfile.phone,
        createdAt: updatedProfile.created_at,
      },
    });
  } catch (error: any) {
    console.error('[Profile PUT API] Unhandled exception:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

