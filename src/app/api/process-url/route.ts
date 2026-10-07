import { after, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { DbService } from '@/lib/services/db.service';
import { buildPlaceSequence } from '@/lib/services/place-sequence.service';
import { AiEnrichmentService } from '@/lib/services/ai-enrichment.service';
import { PipelineLog } from '@/lib/services/pipeline-log';
import { ScraperService } from '@/lib/services/scraper.service';
import type { ApifyOcrFrameResult, GptVisionFrameResult, SocialContent, TranscriptSegment } from '@/lib/types/social';
import type { AudioUploadRef } from '@/lib/services/media-evidence.service';
import { v4 as uuidv4 } from 'uuid';
import { resolveCanonicalSocialSource } from '@/lib/social-source';
import { UrlProcessingJobsService, type UrlProcessingJobStatus } from '@/lib/services/url-processing-jobs.service';
import { urlJobWorkerSecret } from '@/lib/url-job-worker';

export const maxDuration = 300;

async function isUrlJobWorkerRequest(request: Request): Promise<boolean> {
  const secret = urlJobWorkerSecret();
  if (Boolean(secret) && (
    request.headers.get('x-url-job-worker') === secret ||
    request.headers.get('authorization') === `Bearer ${secret}`
  )) return true;

  // The immediate server-side worker has no need for a deployment secret. It
  // proves ownership with the random lock capability written by the claim RPC;
  // neither value is sent to mobile clients or returned by job polling.
  const jobId = request.headers.get('x-url-job-id');
  const workerId = request.headers.get('x-url-job-worker');
  if (!jobId || !workerId) return false;
  const { data } = await supabaseAdmin
    .from('social_post_accesses')
    .select('id')
    .eq('id', jobId)
    .eq('event', 'job')
    .eq('status', 'processing')
    .eq('locked_by', workerId)
    .maybeSingle();
  return Boolean(data?.id);
}

/**
 * Older YouTube results could be marked complete after analyzing only a
 * thumbnail because the downloader's `output.url` artifact was ignored.
 * New runs persist `keyValueStoreId`, so this condition can recover those
 * historical records once without reopening normal completed cache hits.
 */
function needsLegacyYouTubeMediaRecovery(post: unknown): boolean {
  if (!post || typeof post !== 'object') return false;
  const postData = post as { platform?: unknown; raw_apify_data?: unknown };
  if (postData.platform !== 'youtube' || !postData.raw_apify_data || typeof postData.raw_apify_data !== 'object') return false;
  const fallback = (postData.raw_apify_data as { media_fallback?: unknown }).media_fallback;
  return Boolean(fallback && typeof fallback === 'object' &&
    (fallback as { status?: unknown }).status === 'artifact_missing' &&
    !Object.prototype.hasOwnProperty.call(fallback, 'keyValueStoreId'));
}

function originFor(request: Request): string {
  let origin = new URL(request.url).origin;
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) origin = origin.replace('https://', 'http://');
  return origin;
}

/** Claim the shared post before creating the user's job/access row. */
async function claimSocialPostForMobileJob(
  cleanUrl: string,
  platform: 'instagram' | 'tiktok' | 'youtube' | 'facebook',
  canonicalSourceKey: string,
  userId: string,
): Promise<{ post: any; created: boolean }> {
  const supportsCanonicalIdentity = await DbService.supportsColumns(
    'social_posts',
    'canonical_source_key, merged_into_post_id'
  );
  const cleanUrlNoSlash = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
  const cleanUrlWithSlash = `${cleanUrlNoSlash}/`;
  let existingQuery = supabaseAdmin.from('social_posts').select('*');
  existingQuery = supportsCanonicalIdentity
    ? existingQuery.eq('platform', platform).eq('canonical_source_key', canonicalSourceKey).is('merged_into_post_id', null)
    : existingQuery.in('post_url', [cleanUrlNoSlash, cleanUrlWithSlash]);
  const { data: existingPosts, error: existingError } = await existingQuery.order('created_at', { ascending: false });
  if (existingError) throw new Error(`Unable to read social post: ${existingError.message}`);
  const existing = existingPosts?.find((post) => post.status === 'completed') || existingPosts?.[0];
  if (existing) {
    if (!needsLegacyYouTubeMediaRecovery(existing)) return { post: existing, created: false };
    const { data: recovered, error: recoveryError } = await supabaseAdmin
      .from('social_posts')
      .update({ status: 'pending', error_message: null })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (recoveryError || !recovered) {
      throw new Error(`Unable to recover incomplete YouTube media: ${recoveryError?.message || 'missing post'}`);
    }
    return { post: recovered, created: true };
  }

  const contentId = `pending_${uuidv4()}`;
  if (supportsCanonicalIdentity) {
    const { data: inserted, error } = await supabaseAdmin
      .from('social_posts')
      .upsert({
        post_url: cleanUrl,
        canonical_source_key: canonicalSourceKey,
        status: 'pending',
        platform,
        content_id: contentId,
        user_id: userId,
      }, { onConflict: 'platform,canonical_source_key', ignoreDuplicates: true })
      .select('*');
    if (error) throw new Error(`Failed to claim database placeholder: ${error.message}`);
    if (inserted?.[0]) return { post: inserted[0], created: true };
    const { data: claimed, error: claimedError } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .eq('platform', platform)
      .eq('canonical_source_key', canonicalSourceKey)
      .is('merged_into_post_id', null)
      .single();
    if (claimedError || !claimed) throw new Error('Failed to read claimed database placeholder');
    return { post: claimed, created: false };
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('social_posts')
    .insert({ post_url: cleanUrl, status: 'pending', platform, content_id: contentId, user_id: userId })
    .select('*')
    .single();
  if (error || !inserted) throw new Error(`Failed to create database placeholder: ${error?.message || 'missing post'}`);
  return { post: inserted, created: true };
}

function jobStatusForPost(post: any, created: boolean): UrlProcessingJobStatus {
  if (post.status === 'completed') return 'completed';
  if (created || post.status === 'failed') return 'queued';
  return 'waiting';
}

function processingResponse(post: any) {
  return NextResponse.json({
    success: true,
    processing: true,
    status: post.status,
    socialPostId: post.id,
    suggested_title: post.suggested_title ?? null,
    data: post,
    places: [],
    place: null,
    place_id: null,
    placeIds: [],
  }, { status: 202 });
}

function restrictedAccessMessage(rawApifyData: any): string | null {
  const accessFailure = [rawApifyData?.error, rawApifyData?.http_error_reason, rawApifyData?.errorDescription]
    .filter((value) => typeof value === 'string')
    .join(' ');

  return /(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure)
    ? 'restricted'
    : null;
}

function partialResultMessage(placeCount: number): string {
  return placeCount > 0
    ? 'This post contains Restricted content. Place were found.'
    : 'This post contains Restricted content. No places were found.';
}

function usableUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@/, '');
  return username && username.toLowerCase() !== 'unknown' ? username : null;
}

function authorUsernameFromPost(post: any): string | null {
  if (post?.platform === 'youtube') {
    return usableUsername(post?.raw_apify_data?.channelName) ||
      usableUsername(post?.raw_apify_data?.channelHandle) ||
      usableUsername(post?.raw_apify_data?.channelUsername) ||
      usableUsername(post?.author_username);
  }
  return usableUsername(post?.author_username) || usableUsername(post?.raw_apify_data?.user?.username);
}

function tokensFromText(text: string, prefix: '#' | '@'): string[] {
  const escapedPrefix = prefix === '#' ? '\\#' : '@';
  const matches = text.match(new RegExp(`${escapedPrefix}([A-Za-z0-9._]+)`, 'g')) || [];
  return [...new Set(matches.map((match) => match.slice(1)))];
}

function formatResponsePlaces(
  places: any[],
  metadata?: { authorUsername?: string | null; sourceUrl?: string | null; platform?: string | null }
): any[] {
  const authorUsername = usableUsername(metadata?.authorUsername);
  const creatorHandle = authorUsername ? `@${authorUsername}` : null;

  return places.map((place) => ({
    ...place,
    id: place?.id || place?.place_id || null,
    place_id: place?.id || place?.place_id || null,
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    author_username: usableUsername(place?.author_username) || authorUsername,
    creator_handle: usableUsername(place?.creator_handle) ? `@${usableUsername(place.creator_handle)}` : creatorHandle,
    creators: Array.isArray(place?.creators) && place.creators.length > 0
      ? place.creators
      : creatorHandle
        ? [{ creator_handle: creatorHandle, post_url: metadata?.sourceUrl || '', platform: metadata?.platform || '' }]
        : [],
  }));
}

function responsePlaceIds(places: any[]): string[] {
  return places.map((place) => place?.id || place?.place_id).filter(Boolean);
}

/** Prefer the post-place rows; JSON evidence is only a pre-migration fallback. */
async function placeSequenceForResponse(socialPostId: string | null | undefined, places: any[]) {
  const persisted = await DbService.getPlaceSequenceForSocialPost(socialPostId);
  if (persisted.length) return persisted;
  return buildPlaceSequence(places.map((place) => ({
    name: place?.name,
    place_id: place?.id || place?.place_id || null,
    frame_evidence: place?.frame_evidence,
  })));
}

function orderResponsePlaces(places: any[], sequence: Awaited<ReturnType<typeof placeSequenceForResponse>>) {
  const orderById = new Map(sequence.filter((item) => item.place_id).map((item) => [item.place_id!, item.sequence]));
  const orderByName = new Map(sequence.map((item) => [String(item.name || '').trim().toLowerCase(), item.sequence]));
  return [...places].sort((a, b) => {
    const aOrder = orderById.get(a?.id || a?.place_id || '') ?? orderByName.get(String(a?.name || '').trim().toLowerCase()) ?? Number.POSITIVE_INFINITY;
    const bOrder = orderById.get(b?.id || b?.place_id || '') ?? orderByName.get(String(b?.name || '').trim().toLowerCase()) ?? Number.POSITIVE_INFINITY;
    return aOrder - bOrder;
  });
}

/**
 * Instagram's shortcode identifies the post independently of URL spelling
 * (`www`, a trailing slash, and query parameters must not create a new run).
 * Do not infer an identifier for other platforms here: their URL formats are
 * less stable and an incorrect cache hit would return the wrong post.
 */
function instagramShortCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'instagram.com') return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!['p', 'reel', 'reels', 'tv'].includes(segments[0]?.toLowerCase())) return null;

    const shortCode = segments[1]?.trim() || '';
    return /^[A-Za-z0-9_-]+$/.test(shortCode) ? shortCode : null;
  } catch {
    return null;
  }
}

function ocrComparisonFromStoredPost(post: any) {
  const apifyFrames = Array.isArray(post?.ocr_frames_apify) ? post.ocr_frames_apify : [];
  const gptFrames = Array.isArray(post?.ocr_frames_gpt) ? post.ocr_frames_gpt : [];

  return {
    apifyOcr: {
      frames: apifyFrames,
      allTexts: apifyFrames.flatMap((frame: any) => Array.isArray(frame?.texts) ? frame.texts : []),
      totalFramesProcessed: apifyFrames.length,
      processingTimeMs: 0,
    },
    gptVision: {
      frames: gptFrames,
      allTexts: gptFrames.flatMap((frame: any) => Array.isArray(frame?.texts) ? frame.texts : []),
      allBrands: [],
      allLocations: [],
      allPrices: [],
      allCtas: [],
      totalFramesProcessed: gptFrames.length,
      processingTimeMs: 0,
    },
  };
}

function contentFromStoredPost(post: any): SocialContent {
  const raw = post?.raw_apify_data || {};
  const caption = post?.caption || raw?.description || '';
  const platform = ['instagram', 'tiktok', 'youtube', 'facebook'].includes(post?.platform)
    ? post.platform as SocialContent['platform']
    : 'instagram';
  const contentType = ['post', 'reel', 'video'].includes(post?.content_type)
    ? post.content_type
    : 'post';

  return {
    platform,
    contentId: String(post?.content_id || raw?.media_id || raw?.shared_entity_id || post?.id || ''),
    contentType,
    authorUsername: authorUsernameFromPost(post) || 'unknown',
    authorFullName: post?.owner_full_name || '',
    caption,
    videoUrl: post?.video_url || '',
    displayUrl: post?.display_url || '',
    images: [],
    shortCode: post?.short_code || '',
    metrics: {
      likes: post?.likes ?? null,
      views: post?.views ?? null,
      plays: post?.video_plays ?? null,
      comments: post?.comments ?? null,
      shares: null,
      saves: null,
    },
    hashtags: Array.isArray(post?.hashtags) && post.hashtags.length > 0 ? post.hashtags : tokensFromText(caption, '#'),
    mentions: Array.isArray(post?.mentions) && post.mentions.length > 0 ? post.mentions : tokensFromText(caption, '@'),
    taggedUsers: [],
    musicInfo: null,
    videoDuration: post?.video_duration ?? null,
    dimensions: null,
    paidPartnership: Boolean(post?.is_paid_partnership),
    productType: post?.product_type || null,
    publishedAt: null,
    rawApifyData: raw,
    ...ScraperService.extractPlaceSignals(raw, platform),
  };
}

async function runSynchronousPipeline(origin: string, url: string, socialPostId: string, userId?: string): Promise<{ finalPostId: string; analyzeData: any }> {
  console.log(`[Synchronous Pipeline] Starting process-url for: ${url} (origin: ${origin})`);
  const pipelineRunId = uuidv4();
  const pipelineStartedAt = new Date().toISOString();
  try {
    // Update status to scraping
    await supabaseAdmin
      .from('social_posts')
      .update({ status: 'scraping' })
      .eq('id', socialPostId);

    // 1. Initiate Scrape
    const initRes = await fetch(`${origin}/api/process-url/scrape/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, pipelineRunId, pipelineStartedAt }),
    });
    const initData = await initRes.json();
    if (!initRes.ok || !initData.success) {
      throw new Error(initData.error || 'Failed to initiate scrape');
    }
    const { runId, actorId } = initData;

    // Poll status
    let contentData: any = null;
    let rawApifyDataObj: any = null;
    let isDescriptionOnlyPartial = false;
    let pollCount = 0;
    while (true) {
      pollCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusRes = await fetch(
        `${origin}/api/process-url/scrape/status?runId=${encodeURIComponent(runId)}&actorId=${encodeURIComponent(actorId)}&pipelineRunId=${encodeURIComponent(pipelineRunId)}&pipelineStartedAt=${encodeURIComponent(pipelineStartedAt)}&url=${encodeURIComponent(url)}`
      );
      const statusData = await statusRes.json();
      if (!statusRes.ok || !statusData.success) {
        throw new Error(statusData.error || 'Failed to poll status');
      }

      if (statusData.status === 'SUCCEEDED') {
        contentData = statusData.data;
        rawApifyDataObj = statusData.raw;
        isDescriptionOnlyPartial = Boolean(statusData.partial);
        break;
      } else if (
        ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(statusData.status)
      ) {
        throw new Error(`Scraper failed with status: ${statusData.status}`);
      }
    }

    if (!contentData) {
      throw new Error('No content returned from scraper');
    }

    // Update status to processing
    await supabaseAdmin
      .from('social_posts')
      .update({ status: 'processing' })
      .eq('id', socialPostId);

    // 2. Media evidence through /media, exactly as the web client runs it:
    // its own invocation and time budget, skipped for description-only
    // (restricted) pages, and a media failure falls back to metadata-only
    // analysis instead of failing the whole job.
    let whisperTranscript = '';
    let transcriptSegments: TranscriptSegment[] = [];
    let transcriptSource = 'none';
    let transcriptLanguage: string | null = null;
    let ocrResultsList: ApifyOcrFrameResult[] = [];
    let gptVisionResultsList: GptVisionFrameResult[] = [];
    let audioUploadObj: AudioUploadRef | null = null;
    let processingWarnings: string[] = [];
    if (!isDescriptionOnlyPartial) {
      try {
        const mediaRes = await fetch(`${origin}/api/process-url/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: contentData, rawApifyData: rawApifyDataObj, url, socialPostId, pipelineRunId, pipelineStartedAt }),
        });
        const mediaData = await mediaRes.json();
        if (!mediaRes.ok || !mediaData.success) {
          throw new Error(mediaData.error || 'Media processing failed');
        }
        whisperTranscript = mediaData.transcript || '';
        transcriptSegments = mediaData.transcriptSegments || [];
        transcriptSource = mediaData.transcriptSource || 'none';
        transcriptLanguage = mediaData.transcriptLanguage || null;
        ocrResultsList = mediaData.ocrFrames || [];
        gptVisionResultsList = mediaData.visionFrames || [];
        audioUploadObj = mediaData.audioUpload || null;
        processingWarnings = Array.isArray(mediaData.warnings)
          ? mediaData.warnings.filter((warning: unknown): warning is string => typeof warning === 'string' && warning.trim().length > 0)
          : [];
      } catch (mediaErr) {
        console.warn(`[Synchronous Pipeline] Media failed for ${url}, proceeding with metadata only:`, mediaErr instanceof Error ? mediaErr.message : String(mediaErr));
      }
    }

    // 4. Final synthesis and analysis
    const analyzeRes = await fetch(`${origin}/api/process-url/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: contentData,
        rawApifyData: rawApifyDataObj,
        transcript: whisperTranscript,
        transcriptSegments,
        transcriptSource,
        transcriptLanguage,
        apifyOcrFrames: ocrResultsList,
        gptVisionFrames: gptVisionResultsList,
        processingWarnings,
        url,
        audioUploadId: audioUploadObj?.id,
        userId: userId || null,
        socialPostId: socialPostId,
        pipelineRunId,
        pipelineStartedAt,
      }),
    });

    const analyzeData = await analyzeRes.json();
    if (!analyzeRes.ok || !analyzeData.success) {
      throw new Error(analyzeData.error || 'Failed to complete analysis');
    }

    console.log(`[Synchronous Pipeline] Finished processing successfully for: ${url}`);
    return {
      finalPostId: analyzeData.socialPostId || socialPostId,
      analyzeData
    };
  } catch (err: any) {
    console.error(`[Synchronous Pipeline] Error processing: ${url}`, err.message);
    const failureLog = new PipelineLog(`process-url-failure-${socialPostId}`, {
      route: 'process-url', socialPostId, url, pipelineRunId, pipelineStartedAt,
    });
    failureLog.setRunInput({
      platform: url.includes('tiktok.com') ? 'tiktok' : /(?:youtube\.com|youtu\.be)/i.test(url) ? 'youtube' : /(?:facebook\.com|fb\.watch)/i.test(url) ? 'facebook' : 'instagram',
      inputUrl: url,
      socialPostId,
      entrypoint: 'process-url',
    });
    failureLog.fail(err, { failedStage: 'process-url' });
    await failureLog.flushDatabase();
    try {
      await supabaseAdmin
        .from('social_posts')
        .update({
          status: 'failed',
          error_message: err.message || 'Unknown processing error'
        })
        .eq('id', socialPostId);
    } catch (dbErr) {
      console.error('[Synchronous Pipeline] Failed to log failure state to DB:', dbErr);
    }
    throw err;
  }
}

export async function POST(request: Request) {
  try {
    // 1. Optionally resolve user ID — process-url is PUBLIC (no auth required).
    //    Mobile sends clerk_user_id; a verified Clerk token can provide it instead.
    const authUser = await getAuthUser(request);
    const headerUserId = request.headers.get('x-user-id');
    const body = await request.json();
    const {
      url,
      clerk_user_id: bodyClerkUserId,
      clerkUserId: bodyClerkUserIdCamel,
      // The internal worker passes the resolved profile UUID; mobile does not.
      userId: bodyUserId,
    } = body;
    const clerkUserId = typeof bodyClerkUserId === 'string'
      ? bodyClerkUserId
      : typeof bodyClerkUserIdCamel === 'string'
        ? bodyClerkUserIdCamel
        : null;

    // First resolves profiles.clerk_user_id, then returns the internal profile UUID.
    const finalUserId = await resolveProfileId({
      clerkId: authUser?.clerkId || clerkUserId,
      userIdInput: headerUserId || clerkUserId || bodyUserId || authUser?.id,
      email: authUser?.email,
    });
    console.log('[process-url] profile user_id resolved:', finalUserId ?? '(anonymous)');


    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // Canonical identity is established before any placeholder is inserted.
    // Invalid URLs retain the existing request validation behaviour below.
    let source;
    try {
      source = await resolveCanonicalSocialSource(url);
    } catch (_) {
      return NextResponse.json({ error: 'A valid URL is required' }, { status: 400 });
    }
    const { cleanUrl, platform, key: canonicalSourceKey } = source;

    const origin = originFor(request);
    const isWorker = await isUrlJobWorkerRequest(request);

    // Mobile submits only { url, clerk_user_id }. Claim the one shared social post
    // first, then add one user-specific access/job row. The UUID generated by
    // social_post_accesses is returned as jobId immediately.
    if (!isWorker) {
      if (!finalUserId) {
        return NextResponse.json({ success: false, error: 'A valid clerk_user_id is required for mobile processing' }, { status: 400 });
      }

      // Repeated submissions from the same user return their original polling
      // capability. The canonical key treats spelling variants of the same
      // reel as one source while still allowing other users to have jobs.
      const existingJob = await UrlProcessingJobsService.getJobForUserAndSource(finalUserId, canonicalSourceKey);
      if (existingJob) {
        let recoveredLegacyYoutubeMedia = false;
        if (existingJob.status === 'completed' && existingJob.social_post_id) {
          const { data: existingPost, error: postError } = await supabaseAdmin
            .from('social_posts')
            .select('*')
            .eq('id', existingJob.social_post_id)
            .maybeSingle();
          if (postError) throw new Error(`Unable to read existing social post: ${postError.message}`);
          if (needsLegacyYouTubeMediaRecovery(existingPost)) {
            const { error: postRecoveryError } = await supabaseAdmin
              .from('social_posts')
              .update({ status: 'pending', error_message: null })
              .eq('id', existingPost.id);
            if (postRecoveryError) throw new Error(`Unable to recover incomplete YouTube media: ${postRecoveryError.message}`);

            const { error: jobRecoveryError } = await supabaseAdmin
              .from('social_post_accesses')
              .update({
                status: 'queued',
                result: null,
                last_error: null,
                attempt_count: 0,
                run_after: new Date().toISOString(),
              })
              .eq('id', existingJob.id)
              .eq('event', 'job');
            if (jobRecoveryError) throw new Error(`Unable to requeue incomplete YouTube media: ${jobRecoveryError.message}`);
            recoveredLegacyYoutubeMedia = true;
          }
        }
        const jobStatus = recoveredLegacyYoutubeMedia ? 'queued' : existingJob.status;
        const workerScheduled = recoveredLegacyYoutubeMedia || ['queued', 'waiting'].includes(existingJob.status);
        if (workerScheduled) {
          const workerId = `repeat-${uuidv4()}`;
          after(async () => {
            try {
              await UrlProcessingJobsService.drain(origin, workerId, 2);
            } catch (error) {
              console.error('[process-url] repeated mobile job drain failed:', error);
            }
          });
        }
        return NextResponse.json({
          success: true,
          reused: true,
          jobId: existingJob.id,
          socialPostId: existingJob.social_post_id,
          status: jobStatus,
          suggested_title: typeof existingJob.result?.suggested_title === 'string'
            ? existingJob.result.suggested_title
            : null,
          workerScheduled,
          warning: null,
        }, { status: 202 });
      }

      const claimed = await claimSocialPostForMobileJob(cleanUrl, platform, canonicalSourceKey, finalUserId);
      const status = jobStatusForPost(claimed.post, claimed.created);
      const [job] = await UrlProcessingJobsService.createJobs(finalUserId, [{
        source_url: cleanUrl,
        canonical_source_key: canonicalSourceKey,
        platform,
        social_post_id: claimed.post.id,
        status,
        result: status === 'completed'
          ? {
              socialPostId: claimed.post.id,
              socialPostStatus: 'completed',
              suggested_title: claimed.post.suggested_title ?? null,
            }
          : null,
      }]);

      // Also drain when this job is waiting: it may be waiting on an older
      // queued job that was created before a worker became available.
      const workerScheduled = status !== 'completed';
      if (workerScheduled) {
        const workerId = `submit-${uuidv4()}`;
        after(async () => {
          try {
            await UrlProcessingJobsService.drain(origin, workerId, 2);
          } catch (error) {
            console.error('[process-url] immediate mobile job drain failed:', error);
          }
        });
      }
      return NextResponse.json({
        success: true,
        jobId: job.id,
        socialPostId: claimed.post.id,
        status: job.status,
        suggested_title: claimed.post.suggested_title ?? null,
        workerScheduled,
        warning: workerScheduled || status === 'completed'
          ? null
          : status === 'waiting'
            ? 'This URL is already being processed; this job will complete when the shared post completes.'
            : 'Job is queued and will be picked up by the background worker.',
      }, { status: 202 });
    }

    const supportsCanonicalIdentity = await DbService.supportsColumns(
      'social_posts',
      'canonical_source_key, merged_into_post_id'
    );
    const cleanUrlNoSlash = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
    const cleanUrlWithSlash = cleanUrlNoSlash + '/';
    const shortCode = platform === 'instagram' ? instagramShortCodeFromUrl(cleanUrl) : null;

    // Prefer the canonical key for all new records, but keep the immutable
    // Instagram shortcode and URL fallbacks so pre-migration rows are still
    // found rather than scraped again.
    let existingPosts: any[] | null = null;
    if (supportsCanonicalIdentity) {
      const { data, error } = await supabaseAdmin
        .from('social_posts')
        .select('*')
        .eq('platform', platform)
        .eq('canonical_source_key', canonicalSourceKey)
        .is('merged_into_post_id', null)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Failed to look up canonical post: ${error.message}`);
      existingPosts = data;
    }

    if (!existingPosts?.length && shortCode) {
      const { data, error } = await supabaseAdmin
        .from('social_posts')
        .select('*')
        .eq('platform', 'instagram')
        .eq('short_code', shortCode)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Failed to look up Instagram shortcode: ${error.message}`);
      existingPosts = data;
    }

    if (!existingPosts?.length) {
      const { data, error } = await supabaseAdmin
        .from('social_posts')
        .select('*')
        .in('post_url', [cleanUrlNoSlash, cleanUrlWithSlash])
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Failed to look up processed URL: ${error.message}`);
      existingPosts = data;
    }

    const foundCompletedPost = existingPosts?.find(p => p.status === 'completed');
    const existingPost = foundCompletedPost || (existingPosts && existingPosts.length > 0 ? existingPosts[0] : null);

    if (existingPost && existingPost.status === 'completed') {
      const savedPlaces = await DbService.getPlacesForSocialPost(existingPost.id, existingPost.post_url);
      const partialError = restrictedAccessMessage(existingPost.raw_apify_data);
      const cachedContent = contentFromStoredPost(existingPost);

      // A completed post is a cache hit. Return only the persisted result: do
      // not scrape, run OCR, call AI, or write a recovery result on this path.
      const responsePlaces = formatResponsePlaces(savedPlaces, {
        authorUsername: cachedContent.authorUsername,
        sourceUrl: existingPost.post_url,
        platform: cachedContent.platform,
      });
      const places = orderResponsePlaces(responsePlaces, await placeSequenceForResponse(existingPost.id, responsePlaces));
      const firstPlace = places.length > 0 ? places[0] : null;
      const responseData = {
        ...existingPost,
        author_username: cachedContent.authorUsername,
        caption: cachedContent.caption,
        hashtags: cachedContent.hashtags,
        mentions: cachedContent.mentions,
      };

      // Re-run only legacy video records that completed before GPT Vision
      // evidence was stored and still contain an unresolved saved place. This
      // repairs historical partial results once without reprocessing healthy
      // cached posts on every request.
      const hasNoStoredVisionFrames = !Array.isArray(existingPost.ocr_frames_gpt) || existingPost.ocr_frames_gpt.length === 0;
      const hasUnresolvedSavedPlace = savedPlaces.length === 0 || savedPlaces.some((place: any) =>
        place.latitude === null || place.longitude === null || !String(place.address || '').trim()
      );
      const storedOcrTexts = Array.isArray(existingPost.ocr_frames_apify)
        ? existingPost.ocr_frames_apify.flatMap((frame: any) => Array.isArray(frame?.texts) ? frame.texts : [])
        : [];
      const sourceAddressCount = AiEnrichmentService.countDistinctSourceAddresses(storedOcrTexts);
      const hasIncompleteAddressBackedList = sourceAddressCount >= 2 && savedPlaces.length < sourceAddressCount;
      const needsLegacyVideoRecovery =
        (cachedContent.contentType === 'video' && hasNoStoredVisionFrames && hasUnresolvedSavedPlace) ||
        hasIncompleteAddressBackedList;

      if (needsLegacyVideoRecovery) {
        console.warn(
          `[process-url] Reprocessing incomplete cached post ${existingPost.id} ` +
          `(saved=${savedPlaces.length}, source-addresses=${sourceAddressCount}).`
        );
        const { error: retryError } = await supabaseAdmin
          .from('social_posts')
          .update({ status: 'pending', error_message: null })
          .eq('id', existingPost.id);
        if (retryError) {
          console.warn('[process-url] Unable to mark legacy post for recovery:', retryError.message);
        } else {
          // Fall through to the normal pipeline using the existing post ID.
          // The cache returns normally on every later request once recovery succeeds.
        }
      } else {
        if (!isWorker) {
          await DbService.recordSocialPostAccess(existingPost.id, finalUserId, canonicalSourceKey, cleanUrl, 'cache_hit');
        }
        return NextResponse.json({
          success: true,
          cached: true,
          partial: Boolean(partialError),
          error: partialError ? partialResultMessage(places.length) : null,
          socialPostId: existingPost.id,
          suggested_title: existingPost.suggested_title ?? null,
          data: responseData,
          rawApifyData: existingPost.raw_apify_data || null,
          places,
          place: firstPlace,
          place_id: firstPlace?.id || firstPlace?.place_id || null,
          placeIds: responsePlaceIds(places),
          aiAnalysis: existingPost.ai_analysis || null,
          transcript: existingPost.whisper_transcript || null,
          scrapedData: cachedContent,
          ocrComparison: ocrComparisonFromStoredPost(existingPost),
          audioUpload: null,
        });
      }
    }

    // Never run the same pending post twice. The caller can poll GET with the
    // returned socialPostId until the first request reaches completed/failed.
    if (existingPost && ['pending', 'scraping', 'processing'].includes(existingPost.status) && !isWorker) {
      await DbService.recordSocialPostAccess(existingPost.id, finalUserId, canonicalSourceKey, cleanUrl, 'joined_processing');
      return processingResponse(existingPost);
    }

    // Setup temporary placeholder
    const tempContentId = `pending_${uuidv4()}`;

    // Get placeholder ID to track database execution
    let socialPostId = existingPost?.id;
    if (!socialPostId) {
      if (supportsCanonicalIdentity) {
        // INSERT ... ON CONFLICT DO NOTHING is the atomic claim. A second
        // request reads the row created by the first one and receives 202.
        const { data: inserted, error: dbError } = await supabaseAdmin
          .from('social_posts')
          .upsert({
            post_url: cleanUrl,
            canonical_source_key: canonicalSourceKey,
            status: 'pending',
            platform,
            content_id: tempContentId,
            short_code: shortCode,
            user_id: finalUserId || null,
          }, { onConflict: 'platform,canonical_source_key', ignoreDuplicates: true })
          .select('*');
        if (dbError) throw new Error(`Failed to claim database placeholder: ${dbError.message}`);
        const socialPost = inserted?.[0] || (await supabaseAdmin
          .from('social_posts')
          .select('*')
          .eq('platform', platform)
          .eq('canonical_source_key', canonicalSourceKey)
          .is('merged_into_post_id', null)
          .single()).data;
        if (!socialPost) throw new Error('Failed to claim database placeholder');
        if (!inserted?.length && socialPost.status !== 'failed' && !isWorker) {
          await DbService.recordSocialPostAccess(socialPost.id, finalUserId, canonicalSourceKey, cleanUrl, 'joined_processing');
          return processingResponse(socialPost);
        }
        socialPostId = socialPost.id;
      } else {
        const { data: socialPost, error: dbError } = await supabaseAdmin
          .from('social_posts')
          .insert({
            post_url: cleanUrl,
            status: 'pending',
            platform,
            content_id: tempContentId,
            short_code: shortCode,
            user_id: finalUserId || null
          })
          .select('id')
          .single();
        if (dbError || !socialPost) throw new Error(`Failed to create database placeholder: ${dbError?.message}`);
        socialPostId = socialPost.id;
      }
    }

    if (!isWorker) {
      await DbService.recordSocialPostAccess(
        socialPostId,
        finalUserId,
        canonicalSourceKey,
        cleanUrl,
        existingPost?.status === 'failed' ? 'retry' : 'started'
      );
    }

    // Execute the pipeline synchronously and await completion
    const { finalPostId, analyzeData } = await runSynchronousPipeline(origin, cleanUrl, socialPostId, finalUserId || undefined);


    // Fetch and return the completed social post record
    const { data: completedPost, error: fetchErr } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .eq('id', finalPostId)
      .single();

    if (fetchErr || !completedPost) {
      throw new Error(`Failed to fetch completed post: ${fetchErr?.message}`);
    }

    const savedPlaces = await DbService.getPlacesForSocialPost(completedPost.id, completedPost.post_url);
    const analyzedPlaces = Array.isArray(analyzeData?.places)
      ? analyzeData.places
      : (analyzeData?.place && typeof analyzeData.place === 'object' ? [analyzeData.place] : []);
    const savedPlaceKeys = new Set(
      savedPlaces.map((place: any) => `${String(place.name || '').trim().toLowerCase()}|${String(place.city || '').trim().toLowerCase()}`)
    );
    const responseOnlyPlaces = analyzedPlaces.filter((place: any) => {
      const key = `${String(place?.name || '').trim().toLowerCase()}|${String(place?.city || '').trim().toLowerCase()}`;
      return Boolean(place?.name) && !savedPlaceKeys.has(key);
    });
    const responsePlaces = formatResponsePlaces([...savedPlaces, ...responseOnlyPlaces], {
      authorUsername: authorUsernameFromPost(completedPost),
      sourceUrl: completedPost.post_url,
      platform: completedPost.platform,
    });
    const places = orderResponsePlaces(responsePlaces, await placeSequenceForResponse(completedPost.id, responsePlaces));
    const firstPlace = places.length > 0 ? places[0] : null;

    return NextResponse.json({
      success: true,
      partial: Boolean(analyzeData?.partial),
      error: analyzeData?.partial ? analyzeData.error : null,
      warnings: Array.isArray(analyzeData?.warnings) ? analyzeData.warnings : [],
      socialPostId: completedPost.id,
      suggested_title: analyzeData?.suggested_title ?? completedPost.suggested_title ?? null,
      data: completedPost,
      rawApifyData: analyzeData?.rawApifyData || completedPost.raw_apify_data || null,
      places,
      place: firstPlace,
      place_id: firstPlace?.id || firstPlace?.place_id || null,
      placeIds: responsePlaceIds(places),
      aiAnalysis: analyzeData?.aiAnalysis || completedPost.ai_analysis || null,
      transcript: analyzeData?.transcript || completedPost.whisper_transcript || null,
      scrapedData: analyzeData?.scrapedData || contentFromStoredPost(completedPost),
      ocrComparison: analyzeData?.ocrComparison || ocrComparisonFromStoredPost(completedPost),
      audioUpload: analyzeData?.audioUpload || null,
    });
  } catch (error: any) {
    console.error('[Process URL API] Error:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Processing failed'
    }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const url = searchParams.get('url');

    if (!id && !url) {
      return NextResponse.json({ error: 'id or url is required' }, { status: 400 });
    }

    let query = supabaseAdmin.from('social_posts').select('*');
    const supportsCanonicalIdentity = await DbService.supportsColumns(
      'social_posts',
      'canonical_source_key, merged_into_post_id'
    );

    if (id) {
      query = query.eq('id', id);
    } else if (url) {
      try {
        const source = await resolveCanonicalSocialSource(url);
        query = supportsCanonicalIdentity
          ? query.eq('platform', source.platform).eq('canonical_source_key', source.key).is('merged_into_post_id', null)
          : query.in('post_url', [source.cleanUrl, `${source.cleanUrl}/`]);
      } catch (_) {
        return NextResponse.json({ error: 'A valid URL is required' }, { status: 400 });
      }
    }

    const { data: posts, error } = await query.order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!posts || posts.length === 0) {
      return NextResponse.json({ success: false, error: 'Post not found' }, { status: 404 });
    }

    let post = posts.find(p => p.status === 'completed') || posts[0];
    if (supportsCanonicalIdentity && post?.merged_into_post_id) {
      const { data: canonicalPost, error: canonicalError } = await supabaseAdmin
        .from('social_posts')
        .select('*')
        .eq('id', post.merged_into_post_id)
        .single();
      if (canonicalError || !canonicalPost) {
        return NextResponse.json({ success: false, error: 'Canonical post not found' }, { status: 404 });
      }
      post = canonicalPost;
    }

    const responsePlaces = formatResponsePlaces(await DbService.getPlacesForSocialPost(post.id, post.post_url), {
      authorUsername: authorUsernameFromPost(post),
      sourceUrl: post.post_url,
      platform: post.platform,
    });
    const places = orderResponsePlaces(responsePlaces, await placeSequenceForResponse(post.id, responsePlaces));
    const firstPlace = places.length > 0 ? places[0] : null;

    return NextResponse.json({
      success: true,
      status: post.status,
      socialPostId: post.id,
      suggested_title: post.suggested_title ?? null,
      data: post,
      rawApifyData: post.raw_apify_data || null,
      places,
      place: firstPlace,
      place_id: firstPlace?.id || firstPlace?.place_id || null,
      placeIds: responsePlaceIds(places),
      aiAnalysis: post.ai_analysis || null,
      transcript: post.whisper_transcript || null,
      scrapedData: contentFromStoredPost(post),
      ocrComparison: ocrComparisonFromStoredPost(post),
      audioUpload: null,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
