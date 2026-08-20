import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/auth';

/**
 * GET /api/lists
 *
 * Returns lists owned by the authenticated user.
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

    // Fetch lists owned by the user
    const { data: lists, error: listsError } = await supabaseAdmin
      .from('lists')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (listsError) {
      console.error('[Lists GET] Error fetching lists:', listsError);
      return NextResponse.json({ error: listsError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      lists,
    });
  } catch (error: any) {
    console.error('[Lists GET] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/lists
 *
 * Creates a new list for the user.
 *
 * Payload:
 *   title       : string (required)
 *   description?: string
 *   city        ?: string (default: 'New York')
 *   coverEmoji  ?: string (default: '📍')
 *   isPublic    ?: boolean (default: true)
 *   slug        ?: string
 */
export async function POST(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { title, description, city = 'New York', coverEmoji = '📍', isPublic = true, slug: inputSlug } = body;

    if (!title) {
      return NextResponse.json({ error: 'Missing required field: title' }, { status: 400 });
    }

    // Generate URL friendly slug if not provided
    const slug = inputSlug || title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '') + '-' + Math.random().toString(36).substring(2, 6);

    const insertData = {
      user_id: user.id,
      title: title.trim(),
      description: description || null,
      city: city.trim(),
      cover_emoji: coverEmoji.trim(),
      is_public: isPublic,
      slug: slug,
    };

    const { data: newList, error: insertError } = await supabaseAdmin
      .from('lists')
      .insert(insertData)
      .select('*')
      .single();

    if (insertError) {
      console.error('[Lists POST] Error creating list:', insertError);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: 'List created successfully',
      list: newList,
    });
  } catch (error: any) {
    console.error('[Lists POST] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
