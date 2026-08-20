import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { ScraperService } from '@/lib/services/scraper.service';

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    console.log('[Apify Webhook] Received payload:', payload);

    const { runId, status, defaultDatasetId, socialPostId } = payload;

    if (!socialPostId) {
      return NextResponse.json({ success: false, error: 'Missing socialPostId' }, { status: 400 });
    }

    if (status !== 'SUCCEEDED') {
      console.warn(`[Apify Webhook] Run failed for Post ${socialPostId} with status: ${status}`);
      const errorPayload = {
        failed_stage: 'scraping',
        error_code: `APIFY_${status}`,
        retryable: true,
        error_message: `Apify run ended with status: ${status}`
      };
      await supabaseAdmin
        .from('social_posts')
        .update({
          status: 'failed',
          error_message: JSON.stringify(errorPayload),
        })
        .eq('id', socialPostId);
      return NextResponse.json({ success: true, status: 'failed_logged' });
    }

    // 1. Retrieve the post metadata
    const { data: post, error: fetchError } = await supabaseAdmin
      .from('social_posts')
      .select('platform, post_url')
      .eq('id', socialPostId)
      .single();

    if (fetchError || !post) {
      throw new Error(`Failed to find post in database: ${fetchError?.message || 'Not found'}`);
    }

    const actorId = post.platform === 'tiktok' 
      ? 'clockworks/tiktok-scraper' 
      : 'apify/instagram-scraper';

    // 2. Fetch and normalize scraped data from Apify
    console.log(`[Apify Webhook] Fetching dataset ${defaultDatasetId} for post ${socialPostId}...`);
    const { normalized, raw } = await ScraperService.fetchAndNormalize(defaultDatasetId, actorId);

    // 3. Update database with basic card details and change status to 'scraped'
    console.log(`[Apify Webhook] Updating post ${socialPostId} in DB to 'scraped'...`);
    const { error: updateError } = await supabaseAdmin
      .from('social_posts')
      .update({
        status: 'scraped',
        display_url: normalized.displayUrl || '',
        video_url: normalized.videoUrl || '',
        caption: normalized.caption || '',
        author_username: normalized.authorUsername || 'unknown',
        owner_full_name: normalized.authorFullName || '',
        likes: normalized.metrics.likes != null ? Math.round(Number(normalized.metrics.likes)) : 0,
        comments: normalized.metrics.comments != null ? Math.round(Number(normalized.metrics.comments)) : 0,
        content_type: normalized.contentType || 'reel',
        content_id: normalized.contentId,
        raw_apify_data: raw,
      })
      .eq('id', socialPostId);

    if (updateError) {
      throw new Error(`Failed to update post status in DB: ${updateError.message}`);
    }

    console.log(`[Apify Webhook] Ingestion completed for post: ${socialPostId}`);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[Apify Webhook] Fatal error:', err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
