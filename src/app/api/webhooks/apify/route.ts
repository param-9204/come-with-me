import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { ScraperService } from '@/lib/services/scraper.service';
import { ExtractionLogStore } from '@/lib/services/extraction-log.store';

/**
 * Scrape stage + Apify usage for the extraction run (when the run id was put
 * in the webhook payload). Logging never fails the webhook.
 */
async function logScrape(
  extractionRunId: unknown,
  apifyRunId: unknown,
  actorId: string | null,
  ok: boolean,
  error: string | null,
  patch?: Record<string, unknown>
): Promise<void> {
  if (typeof extractionRunId !== 'string' || !extractionRunId) return;
  try {
    const usage = typeof apifyRunId === 'string' && apifyRunId
      ? await ScraperService.getScrapeStatus(apifyRunId).catch(() => null)
      : null;
    await ExtractionLogStore.persistDetached(extractionRunId, {
      stages: [{
        stage: 'scrape',
        provider: 'apify',
        status: ok ? 'success' : 'failed',
        startedAt: usage?.startedAt || new Date().toISOString(),
        durationMs: usage?.durationMs ?? 0,
        itemsIn: 1,
        itemsOut: ok ? 1 : 0,
        error,
      }],
      calls: [{
        stage: 'scrape',
        operation: 'scrape',
        provider: 'apify',
        model: actorId || usage?.actId || null,
        status: ok ? 'success' : 'error',
        latencyMs: usage?.durationMs ?? null,
        error,
        costUsd: usage?.usageTotalUsd ?? null,
        costSource: usage?.usageTotalUsd != null ? 'provider_reported' : null,
      }],
      patch,
    });
  } catch (logError) {
    console.warn('[Apify Webhook] Could not log the scrape stage:', logError instanceof Error ? logError.message : logError);
  }
}

export async function POST(request: Request) {
  let webhookRunIds: { extractionRunId?: unknown; runId?: unknown } = {};
  try {
    const payload = await request.json();
    console.log('[Apify Webhook] Received payload:', payload);

    const { runId, status, defaultDatasetId, socialPostId, extractionRunId } = payload;
    webhookRunIds = { extractionRunId, runId };

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
      await logScrape(extractionRunId, runId, null, false, errorPayload.error_message, {
        status: 'failed',
        failed_stage: 'scraping',
        error_code: errorPayload.error_code,
        error_message: errorPayload.error_message,
        finished_at: new Date().toISOString(),
      });
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

    await logScrape(extractionRunId, runId, actorId, true, null, {
      content_id: normalized.contentId && !String(normalized.contentId).startsWith('pending_') ? String(normalized.contentId) : null,
      content_type: normalized.contentType || null,
    });
    console.log(`[Apify Webhook] Ingestion completed for post: ${socialPostId}`);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[Apify Webhook] Fatal error:', err.message);
    await logScrape(webhookRunIds.extractionRunId, webhookRunIds.runId, null, false, err.message || 'Webhook ingestion failed', {
      status: 'failed',
      failed_stage: 'scrape_ingest',
      error_code: 'WEBHOOK_INGEST_FAILURE',
      error_message: err.message || 'Webhook ingestion failed',
    });
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
