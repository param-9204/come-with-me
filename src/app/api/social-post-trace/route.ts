import { NextResponse } from 'next/server';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Read-only, owner-scoped support export for one social post short code.
 * Requires migration_v27_social_post_trace.sql because the database function
 * assembles the raw post, media, audit trail, evidence, candidates, and errors.
 */
export async function GET(request: Request) {
  const shortCode = new URL(request.url).searchParams.get('short_code')?.trim() || '';
  if (!shortCode) {
    return NextResponse.json({ success: false, error: 'short_code query parameter is required.' }, { status: 400 });
  }
  if (shortCode.length > 300) {
    return NextResponse.json({ success: false, error: 'short_code is too long.' }, { status: 400 });
  }

  const authUser = await getAuthUser(request);
  if (!authUser) {
    return NextResponse.json({ success: false, error: 'Authentication is required.' }, { status: 401 });
  }

  const profileId = await resolveProfileId({
    clerkId: authUser.clerkId,
    userIdInput: authUser.id,
    email: authUser.email,
  });
  if (!profileId) {
    return NextResponse.json({ success: false, error: 'Could not resolve the authenticated profile.' }, { status: 403 });
  }

  // Confirm ownership before calling the SECURITY DEFINER export function.
  const { data: ownedPosts, error: ownershipError } = await supabaseAdmin
    .from('social_posts')
    .select('id')
    .eq('short_code', shortCode)
    .eq('user_id', profileId);

  if (ownershipError) {
    console.error('[social-post-trace] Ownership query failed:', ownershipError.message);
    return NextResponse.json({ success: false, error: 'Could not load the social post.' }, { status: 500 });
  }
  if (!ownedPosts?.length) {
    return NextResponse.json({ success: false, error: 'No matching social post was found for this account.' }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin.rpc('get_social_post_trace', { p_short_code: shortCode });
  if (error) {
    console.error('[social-post-trace] Trace export failed:', error.message);
    return NextResponse.json({
      success: false,
      error: 'Trace export is unavailable. Apply supabase/migration_v27_social_post_trace.sql first.',
    }, { status: 500 });
  }

  const ownedIds = new Set(ownedPosts.map((post) => post.id));
  const trace = data && typeof data === 'object'
    ? {
      ...(data as Record<string, unknown>),
      posts: Array.isArray((data as { posts?: unknown }).posts)
        ? (data as { posts: Array<{ social_post_id?: string }> }).posts.filter((post) => ownedIds.has(post.social_post_id || ''))
        : [],
    }
    : { short_code: shortCode, posts: [] };

  return NextResponse.json({
    success: true,
    social_post_ids: [...ownedIds],
    trace,
  });
}
