import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/auth';

/**
 * PUT /api/profile
 *
 * Request Body:
 *   displayName? : string
 *   handle?      : string (alphanumeric, periods, or underscores, lowercase, 3-30 chars)
 *   avatarUrl?   : string
 *   role?        : 'explorer' | 'creator' | 'brand'
 *   homeCity?    : string
 *   bio?         : string
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

    const { displayName, handle, avatarUrl, role, homeCity, bio } = body;

    // 3. Prepare the database update object
    const updateData: Record<string, any> = {};

    // 4. Validate fields and build update object
    if (displayName !== undefined) {
      updateData.display_name = typeof displayName === 'string' ? displayName.trim() : displayName;
    }

    if (handle !== undefined) {
      if (handle === null) {
        updateData.handle = null;
      } else if (typeof handle !== 'string') {
        return NextResponse.json(
          { error: 'Profile handle must be a string' },
          { status: 400 }
        );
      } else {
        const cleanedHandle = handle.trim().toLowerCase();
        
        // Validation: handle length between 3 and 30 characters
        if (cleanedHandle.length < 3 || cleanedHandle.length > 30) {
          return NextResponse.json(
            { error: 'Profile handle must be between 3 and 30 characters long' },
            { status: 400 }
          );
        }

        // Validation: check allowed characters (alphanumeric, dots, underscores)
        const handleRegex = /^[a-z0-9._]+$/;
        if (!handleRegex.test(cleanedHandle)) {
          return NextResponse.json(
            { error: 'Profile handle can only contain lowercase letters, numbers, periods (.), and underscores (_)' },
            { status: 400 }
          );
        }

        updateData.handle = cleanedHandle;
      }
    }

    if (avatarUrl !== undefined) {
      updateData.avatar_url = typeof avatarUrl === 'string' ? avatarUrl.trim() : avatarUrl;
    }

    if (role !== undefined) {
      const allowedRoles = ['explorer', 'creator', 'brand'];
      if (!allowedRoles.includes(role)) {
        return NextResponse.json(
          { error: `Invalid role. Allowed roles: ${allowedRoles.join(', ')}` },
          { status: 400 }
        );
      }
      updateData.role = role;
    }

    if (homeCity !== undefined) {
      updateData.home_city = typeof homeCity === 'string' ? homeCity.trim() : homeCity;
    }

    if (bio !== undefined) {
      updateData.bio = typeof bio === 'string' ? bio.trim() : bio;
    }

    // Check if there are fields to update
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields provided for update' },
        { status: 400 }
      );
    }

    // 5. Update user profile in database
    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update(updateData)
      .eq('id', user.id)
      .select('*')
      .maybeSingle();

    if (updateError) {
      // Postgres UNIQUE constraint error code
      if (updateError.code === '23505') {
        return NextResponse.json(
          { error: 'Username handle is already taken' },
          { status: 400 }
        );
      }

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
        handle: updatedProfile.handle,
        displayName: updatedProfile.display_name,
        avatarUrl: updatedProfile.avatar_url,
        role: updatedProfile.role,
        homeCity: updatedProfile.home_city,
        bio: updatedProfile.bio,
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
