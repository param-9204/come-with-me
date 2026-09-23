import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { v4 as uuidv4 } from 'uuid';
import { after } from 'next/server';
import { ScraperService } from '@/lib/services/scraper.service';
import { DbService } from '@/lib/services/db.service';

// The background pipeline runs in `after()` within this invocation.
export const maxDuration = 300;

async function runBackgroundPipeline(
  origin: string,
  cleanUrl: string,
  socialPostId: string,
  userId: string | null,
  contentData: any,
  rawApifyDataObj: any
) {
  console.log(`[Background Pipeline] Starting for: ${cleanUrl} (ID: ${socialPostId})`);
  let currentStage = 'media';
  try {
    // One shared media pipeline (key frames → local OCR → vision fallback on
    // hard frames; platform subtitles or Whisper). Every stage is non-fatal.
    const { MediaEvidenceService } = await import('@/lib/services/media-evidence.service');
    const { PipelineLog, withPipelineLog } = await import('@/lib/services/pipeline-log');
    const mediaLog = new PipelineLog(String(contentData?.contentId || socialPostId), { route: 'stream', socialPostId, url: cleanUrl });
    const media = await withPipelineLog(mediaLog, () => MediaEvidenceService.collect(contentData, rawApifyDataObj));
    mediaLog.flush();
    const ocrResultsList = media.ocrFrames;
    const gptVisionResultsList = media.visionFrames;
    const whisperTranscript = media.transcriptText;
    const audioUploadObj = media.audioUpload;
    for (const step of media.steps) {
      console.log(`[Background Pipeline] ${step.name}: ${step.status} — ${step.details}`);
    }

    // ── GPT Analysis & DB Save ─────────────────────────────────────────────────
    currentStage = 'analysis';
    await supabaseAdmin
      .from('social_posts')
      .update({ status: 'processing:analysis' })
      .eq('id', socialPostId);

    const analyzeRes = await fetch(`${origin}/api/process-url/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: contentData,
        rawApifyData: rawApifyDataObj,
        transcript: whisperTranscript,
        transcriptSegments: media.transcript?.segments || [],
        transcriptSource: media.transcript?.source || 'none',
        transcriptLanguage: media.transcript?.language || null,
        apifyOcrFrames: ocrResultsList,
        gptVisionFrames: gptVisionResultsList,
        url: cleanUrl,
        audioUploadId: audioUploadObj?.id,
        userId,
        socialPostId,
      }),
    });

    const analyzeData = await analyzeRes.json();
    if (!analyzeRes.ok || !analyzeData.success) {
      throw new Error(analyzeData.error || 'Analysis failed');
    }

    console.log(`[Background Pipeline] Finished successfully for: ${cleanUrl}`);
  } catch (err: any) {
    console.error(`[Background Pipeline] Critical failure for URL: ${cleanUrl}`, err.message);
    const errorPayload = {
      failed_stage: currentStage,
      error_code: err.code || `${currentStage.toUpperCase()}_FAILURE`,
      retryable: true,
      error_message: err.message || 'Unknown processing error'
    };
    try {
      await supabaseAdmin
        .from('social_posts')
        .update({
          status: 'failed',
          error_message: JSON.stringify(errorPayload)
        })
        .eq('id', socialPostId);
    } catch (dbErr) {
      console.error('[Background Pipeline] Failed to log failure state to DB:', dbErr);
    }
  }
}

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('data: {"error":"Invalid JSON body"}\n\n', { status: 400 });
  }

  const { url, userId } = body;

  const authUser = await getAuthUser(request);
  const resolvedUserId = await resolveProfileId({
    clerkId: authUser?.clerkId,
    userIdInput: userId || authUser?.id,
    email: authUser?.email,
  });

  if (!url) {

    return new Response('data: {"error":"URL is required"}\n\n', { status: 400 });
  }

  // Clean URL — strip query params
  let cleanUrl = url as string;
  try {
    const parsedUrl = new URL(url);
    cleanUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch (_) { }

  // Resolve origin for internal fetch calls
  let origin = new URL(request.url).origin;
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    origin = origin.replace('https://', 'http://');
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        try {
          const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch (_) { }
      };

      let socialPostId: string | undefined;

      try {
        // ── 0. Check for cached completed post ──────────────────────────────
        const cleanUrlNoSlash = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
        const cleanUrlWithSlash = cleanUrlNoSlash + '/';
        const cleanUrlReelNoSlash = cleanUrlNoSlash.replace('/reels/', '/reel/');
        const cleanUrlReelWithSlash = cleanUrlReelNoSlash + '/';
        const cleanUrlReelsNoSlash = cleanUrlNoSlash.replace('/reel/', '/reels/');
        const cleanUrlReelsWithSlash = cleanUrlReelsNoSlash + '/';

        const { data: existingPosts } = await supabaseAdmin
          .from('social_posts')
          .select('*')
          .in('post_url', [
            cleanUrlNoSlash,
            cleanUrlWithSlash,
            cleanUrlReelNoSlash,
            cleanUrlReelWithSlash,
            cleanUrlReelsNoSlash,
            cleanUrlReelsWithSlash
          ])
          .order('created_at', { ascending: false });

        const foundCompletedPost = existingPosts?.find(p => p.status === 'completed');
        const existingPost = foundCompletedPost || (existingPosts && existingPosts.length > 0 ? existingPosts[0] : null);

        if (existingPost && existingPost.status === 'completed') {
          let places = await DbService.getPlacesForSocialPost(existingPost.id, existingPost.post_url);



          const cleanPost = { ...(existingPost || {}) };
          delete cleanPost.raw_apify_data;
          delete cleanPost.ai_analysis;

          send('complete', {
            ...cleanPost,
            places: places.map(p => {
              const { audio_transcript, ...rest } = p;
              return {
                ...rest,
                social_post_id: existingPost.id
              };
            }),
            cached: true,
          });
          controller.close();
          return;
        }

        // ── 1. Insert/Retrieve placeholder row ────────────────────────────────
        const platform = cleanUrl.includes('tiktok.com') ? 'tiktok' : 'instagram';
        socialPostId = existingPost?.id;

        if (!socialPostId) {
          const { data: socialPost, error: dbError } = await supabaseAdmin
            .from('social_posts')
            .insert({
              post_url: cleanUrl,
              status: 'pending',
              platform,
              content_id: `pending_${uuidv4()}`,
              user_id: resolvedUserId,

            })
            .select('id')
            .single();

          if (dbError || !socialPost) {
            send('error', { error: `DB error: ${dbError?.message}` });
            controller.close();
            return;
          }
          socialPostId = socialPost.id;
        }

        // ── 2. Notify client: scraping started ──────────────────────────────
        send('scraping', { socialPostId, status: 'scraping' });

        await supabaseAdmin
          .from('social_posts')
          .update({ status: 'scraping' })
          .eq('id', socialPostId);

        // ── 3. Initiate Apify scrape with Webhook ────────────────────────────
        let webhookUrl = `${origin}/api/webhooks/apify`;
        const forwardedHost = request.headers.get('x-forwarded-host');
        const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
        if (forwardedHost) {
          webhookUrl = `${forwardedProto}://${forwardedHost}/api/webhooks/apify`;
        }
        console.log(`[SSE Stream] Initiating scrape with webhookUrl: ${webhookUrl}`);

        await ScraperService.initiateScrape(cleanUrl, webhookUrl, socialPostId);

        // ── 4. Poll database status and stream pipeline progression ─────────
        let contentData: any = null;
        let rawApifyDataObj: any = null;
        let currentStatus = 'scraping';

        while (true) {
          // Poll database every 400ms
          await new Promise((resolve) => setTimeout(resolve, 400));

          const { data: dbPost, error: pollError } = await supabaseAdmin
            .from('social_posts')
            .select('status, raw_apify_data, error_message, place_id, post_url')
            .eq('id', socialPostId)
            .single();

          if (pollError) {
            console.error('[SSE Stream] DB poll error:', pollError.message);
            continue;
          }

          if (dbPost?.status && dbPost.status !== currentStatus) {
            currentStatus = dbPost.status;
            console.log(`[SSE Stream] Status transitioned to: ${currentStatus}`);

            if (currentStatus === 'scraped') {
              rawApifyDataObj = dbPost.raw_apify_data;
              if (rawApifyDataObj) {
                const { normalized } = platform === 'tiktok'
                  ? await ScraperService.normalizeTikTokRaw(rawApifyDataObj)
                  : ScraperService.normalizeInstagramRaw(rawApifyDataObj);
                contentData = normalized;
              }
              const basicCard = {
                displayUrl: contentData?.displayUrl || null,
                videoUrl: contentData?.videoUrl || null,
                caption: contentData?.caption || null,
                ownerUsername: contentData?.authorUsername || null,
                ownerFullName: contentData?.authorFullName || null,
                locationName: (contentData as any)?.locationName || null,
                likesCount: contentData?.metrics?.likes || 0,
                commentsCount: contentData?.metrics?.comments || 0,
                contentType: contentData?.contentType || null,
                platform,
                timestamp: contentData?.publishedAt || null,
              };

              send('scraped', {
                socialPostId,
                status: 'scraped',
                data: basicCard,
              });

              // Transition the database to processing:media
              await supabaseAdmin
                .from('social_posts')
                .update({ status: 'processing:media' })
                .eq('id', socialPostId);

              // Kick off media processing pipeline asynchronously
              const bgPromise = runBackgroundPipeline(
                origin,
                cleanUrl,
                socialPostId!,
                userId || null,
                contentData,
                rawApifyDataObj
              );
              try {
                after(() => bgPromise);
              } catch (_) { }
            }
            else if (currentStatus === 'processing:media') {
              send('processing', {
                socialPostId,
                status: 'processing:media',
                failed_stage: null,
                error_message: null,
              });
            }
            else if (currentStatus === 'processing:analysis') {
              send('processing', {
                socialPostId,
                status: 'processing:analysis',
                failed_stage: null,
                error_message: null,
              });
            }
            else if (currentStatus === 'completed') {
              // Fetch final mapped places associated with this post
              const places = await DbService.getPlacesForSocialPost(socialPostId, dbPost.post_url);

              // Fetch the latest updated social post record
              const { data: finalPost } = await supabaseAdmin
                .from('social_posts')
                .select('*')
                .eq('id', socialPostId)
                .single();

              const cleanPost = { ...(finalPost || dbPost || {}) };
              delete cleanPost.raw_apify_data;
              delete cleanPost.ai_analysis;

              send('complete', {
                ...cleanPost,
                places: places.map(p => {
                  const { audio_transcript, ...rest } = p;
                  return {
                    ...rest,
                    social_post_id: socialPostId
                  };
                }),
                cached: false,
              });
              controller.close();
              break;
            }
            else if (currentStatus === 'failed') {
              let errorMsg = dbPost.error_message || 'Processing failed';
              try {
                // Parse structured JSON error
                const parsedError = JSON.parse(errorMsg);
                send('error', parsedError);
              } catch (_) {
                send('error', {
                  failed_stage: 'unknown',
                  error_code: 'PIPELINE_FAILURE',
                  retryable: true,
                  error_message: errorMsg,
                });
              }
              controller.close();
              break;
            }
          }
        }

      } catch (err: any) {
        console.error('[SSE Stream] Pipeline error:', err.message);

        if (socialPostId) {
          try {
            await supabaseAdmin
              .from('social_posts')
              .update({ status: 'failed', error_message: err.message })
              .eq('id', socialPostId);
          } catch (_) { }
        }

        send('error', { error: err.message || 'Processing failed' });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
