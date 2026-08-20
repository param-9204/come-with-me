import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/auth';

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

    // 5. Update user profile in database
    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update(updateData)
      .eq('id', user.id)
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

