import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { DbService } from '@/lib/services/db.service';
import { AiEnrichmentService } from '@/lib/services/ai-enrichment.service';
import type { SocialContent } from '@/lib/types/social';
import { v4 as uuidv4 } from 'uuid';

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
  const platform = post?.platform === 'tiktok' ? 'tiktok' : 'instagram';
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
  };
}

async function runSynchronousPipeline(origin: string, url: string, socialPostId: string, userId?: string): Promise<{ finalPostId: string; analyzeData: any }> {
  console.log(`[Synchronous Pipeline] Starting process-url for: ${url} (origin: ${origin})`);
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
      body: JSON.stringify({ url }),
    });
    const initData = await initRes.json();
    if (!initRes.ok || !initData.success) {
      throw new Error(initData.error || 'Failed to initiate scrape');
    }
    const { runId, actorId } = initData;

    // Poll status
    let contentData: any = null;
    let rawApifyDataObj: any = null;
    let pollCount = 0;
    while (true) {
      pollCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusRes = await fetch(
        `${origin}/api/process-url/scrape/status?runId=${runId}&actorId=${actorId}`
      );
      const statusData = await statusRes.json();
      if (!statusRes.ok || !statusData.success) {
        throw new Error(statusData.error || 'Failed to poll status');
      }

      if (statusData.status === 'SUCCEEDED') {
        contentData = statusData.data;
        rawApifyDataObj = statusData.raw;
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

    const isVideo =
      !!contentData.videoUrl &&
      (contentData.contentType === 'video' ||
        contentData.contentType === 'reel');

    let whisperTranscript = '';
    let audioUploadObj: any = null;
    let ocrResultsList: any[] = [];
    let gptVisionResultsList: any[] = [];

    // 2. Transcribe (if video) and OCR in parallel
    const transcriptionPromise = (async () => {
      if (isVideo) {
        try {
          const transcribeRes = await fetch(`${origin}/api/process-url/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoUrl: contentData.videoUrl }),
          });
          const transcribeData = await transcribeRes.json();
          if (transcribeRes.ok && transcribeData.success) {
            whisperTranscript = transcribeData.transcript;
            audioUploadObj = transcribeData.audioUpload;
          }
        } catch (err: any) {
          console.warn('[Synchronous Pipeline] Transcription failed, proceeding:', err.message);
        }
      }
    })();

    const ocrPromise = (async () => {
      const runWithConcurrency = async <T, R>(
        items: T[],
        limit: number,
        fn: (item: T, idx: number) => Promise<R>
      ): Promise<R[]> => {
        const results: R[] = new Array(items.length);
        let idx = 0;
        async function worker() {
          while (idx < items.length) {
            const current = idx++;
            results[current] = await fn(items[current], current);
          }
        }
        const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
        await Promise.all(workers);
        return results;
      };

      if (isVideo) {
        const duration = contentData.videoDuration || 15;
        const numFrames = Math.max(1, Math.round(duration));
        const timestamps: { index: number; timestamp: number }[] = [];
        for (let i = 0; i < numFrames; i++) {
          timestamps.push({ index: i, timestamp: i });
        }

        const rawOcr = await runWithConcurrency(timestamps, 10, async (item) => {
          try {
            const res = await fetch(`${origin}/api/process-url/ocr-frame`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                videoUrl: contentData.videoUrl,
                frameIndex: item.index,
                timestamp: item.timestamp,
                isVideo: true,
                platform: contentData.platform,
              }),
            });
            const resData = await res.json();
            if (res.ok && resData.success && resData.ocrFrameResult) {
              if (resData.gptVisionFrameResult) gptVisionResultsList.push(resData.gptVisionFrameResult);
              return resData.ocrFrameResult;
            }
          } catch (e) {
            console.error(`Frame OCR error for index ${item.index}:`, e);
          }
          return null;
        });
        ocrResultsList = rawOcr.filter(Boolean);
      } else {
        const imageUrls =
          contentData.images && contentData.images.length > 0
            ? contentData.images
            : [contentData.displayUrl || contentData.videoUrl].filter(
              Boolean
            ) as string[];

        if (imageUrls.length > 0) {
          const rawOcr = await runWithConcurrency(imageUrls, 10, async (imageUrl, index) => {
            try {
              const res = await fetch(`${origin}/api/process-url/ocr-frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  imageUrl,
                  frameIndex: index,
                  isVideo: false,
                  platform: contentData.platform,
                }),
              });
              const resData = await res.json();
              if (res.ok && resData.success && resData.ocrFrameResult) {
                if (resData.gptVisionFrameResult) gptVisionResultsList.push(resData.gptVisionFrameResult);
                return resData.ocrFrameResult;
              }
            } catch (e) {
              console.error(`Image OCR error for index ${index}:`, e);
            }
            return null;
          });
          ocrResultsList = rawOcr.filter(Boolean);
        }
      }
    })();

    await Promise.all([transcriptionPromise, ocrPromise]);

    // 4. Final synthesis and analysis
    const analyzeRes = await fetch(`${origin}/api/process-url/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: contentData,
        rawApifyData: rawApifyDataObj,
        transcript: whisperTranscript,
        apifyOcrFrames: ocrResultsList,
        gptVisionFrames: gptVisionResultsList,
        url,
        audioUploadId: audioUploadObj?.id,
        userId: userId || null,
        socialPostId: socialPostId
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
    //    If the client sends a Clerk Bearer token, middleware header, or userId in
    //    the body, capture it so we can attribute the post to that user.
    const authUser = await getAuthUser(request);
    const headerUserId = request.headers.get('x-user-id');
    const body = await request.json();
    const { url, userId: bodyUserId } = body;

    // Resolve profile identity against public.profiles to guarantee valid profile UUID
    const finalUserId = await resolveProfileId({
      clerkId: authUser?.clerkId,
      userIdInput: headerUserId || bodyUserId || authUser?.id,
      email: authUser?.email,
    });
    console.log('[process-url] profile user_id resolved:', finalUserId ?? '(anonymous)');


    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // Clean URL (strip query parameters)
    let cleanUrl = url;
    try {
      const parsedUrl = new URL(url);
      cleanUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch (_) { }

    let origin = new URL(request.url).origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      origin = origin.replace('https://', 'http://');
    }

    const cleanUrlNoSlash = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
    const cleanUrlWithSlash = cleanUrlNoSlash + '/';

    // Check if the URL has already been processed and is complete
    const { data: existingPosts } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .in('post_url', [cleanUrlNoSlash, cleanUrlWithSlash])
      .order('created_at', { ascending: false });

    const foundCompletedPost = existingPosts?.find(p => p.status === 'completed');
    const existingPost = foundCompletedPost || (existingPosts && existingPosts.length > 0 ? existingPosts[0] : null);

    if (existingPost && existingPost.status === 'completed') {
      let savedPlaces = await DbService.getPlacesForSocialPost(existingPost.id, existingPost.post_url);
      const partialError = restrictedAccessMessage(existingPost.raw_apify_data);
      let responseOnlyPlaces: any[] = [];
      const cachedContent = contentFromStoredPost(existingPost);

      // Restricted records saved by older versions may contain only the raw
      // Apify payload. Repair the source-backed post fields before returning
      // it so creator metadata is never reported as "unknown".
      if (partialError && (existingPost.author_username !== cachedContent.authorUsername || existingPost.caption !== cachedContent.caption)) {
        const { error: postRepairError } = await supabaseAdmin
          .from('social_posts')
          .update({
            author_username: cachedContent.authorUsername,
            caption: cachedContent.caption,
            hashtags: cachedContent.hashtags,
            mentions: cachedContent.mentions,
          })
          .eq('id', existingPost.id);
        if (postRepairError) {
          console.warn('[process-url] Failed to repair cached restricted post fields:', postRepairError.message);
        }
      }

      if (partialError && savedPlaces.length === 0 && (existingPost.caption || existingPost.raw_apify_data?.description)) {
        try {
          responseOnlyPlaces = await AiEnrichmentService.extractPlace(
            cachedContent,
            existingPost.whisper_transcript || '',
            []
          );
          const savedIds = await Promise.all(responseOnlyPlaces.map((place) =>
            DbService.savePlace(
              place,
              existingPost.post_url,
              cachedContent.platform,
              existingPost.whisper_transcript || '',
              undefined,
              existingPost.id,
              cachedContent.authorUsername
            )
          ));
          if (savedIds.some(Boolean)) {
            savedPlaces = await DbService.getPlacesForSocialPost(existingPost.id, existingPost.post_url);
            const savedPlaceKeys = new Set(savedPlaces.map((place: any) =>
              `${String(place.name || '').trim().toLowerCase()}|${String(place.city || '').trim().toLowerCase()}`
            ));
            responseOnlyPlaces = responseOnlyPlaces.filter((place) =>
              !savedPlaceKeys.has(`${String(place.name || '').trim().toLowerCase()}|${String(place.city || '').trim().toLowerCase()}`)
            );
          }
          console.log(`[process-url] Recovered ${responseOnlyPlaces.length} place(s) from cached restricted post ${existingPost.id}.`);
        } catch (placeError: any) {
          console.warn('[process-url] Cached restricted-place recovery failed:', placeError.message);
        }
      }

      const places = formatResponsePlaces([...savedPlaces, ...responseOnlyPlaces], {
        authorUsername: cachedContent.authorUsername,
        sourceUrl: existingPost.post_url,
        platform: cachedContent.platform,
      });
      const firstPlace = places.length > 0 ? places[0] : null;
      const responseData = {
        ...existingPost,
        author_username: cachedContent.authorUsername,
        caption: cachedContent.caption,
        hashtags: cachedContent.hashtags,
        mentions: cachedContent.mentions,
      };

      return NextResponse.json({
        success: true,
        partial: Boolean(partialError),
        error: partialError ? partialResultMessage(places.length) : null,
        socialPostId: existingPost.id,
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

    // Setup temporary placeholder
    const platform = cleanUrl.includes('tiktok.com') ? 'tiktok' : 'instagram';
    const tempContentId = `pending_${uuidv4()}`;

    // Get placeholder ID to track database execution
    let socialPostId = existingPost?.id;
    if (!socialPostId) {
      const { data: socialPost, error: dbError } = await supabaseAdmin
        .from('social_posts')
        .insert({
          post_url: cleanUrl,
          status: 'pending',
          platform,
          content_id: tempContentId,
          user_id: finalUserId || null
        })
        .select('id')
        .single();

      if (dbError || !socialPost) {
        throw new Error(`Failed to create database placeholder: ${dbError?.message}`);
      }
      socialPostId = socialPost.id;
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
    const places = formatResponsePlaces([...savedPlaces, ...responseOnlyPlaces], {
      authorUsername: authorUsernameFromPost(completedPost),
      sourceUrl: completedPost.post_url,
      platform: completedPost.platform,
    });
    const firstPlace = places.length > 0 ? places[0] : null;

    return NextResponse.json({
      success: true,
      partial: Boolean(analyzeData?.partial),
      error: analyzeData?.partial ? analyzeData.error : null,
      socialPostId: completedPost.id,
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

    if (id) {
      query = query.eq('id', id);
    } else if (url) {
      let cleanUrl = url;
      try {
        const parsed = new URL(url);
        cleanUrl = `${parsed.origin}${parsed.pathname}`;
      } catch (_) { }
      const cleanUrlNoSlash = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
      const cleanUrlWithSlash = cleanUrlNoSlash + '/';
      query = query.in('post_url', [cleanUrlNoSlash, cleanUrlWithSlash]);
    }

    const { data: posts, error } = await query.order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!posts || posts.length === 0) {
      return NextResponse.json({ success: false, error: 'Post not found' }, { status: 404 });
    }

    const post = posts.find(p => p.status === 'completed') || posts[0];

    const places = formatResponsePlaces(await DbService.getPlacesForSocialPost(post.id, post.post_url), {
      authorUsername: authorUsernameFromPost(post),
      sourceUrl: post.post_url,
      platform: post.platform,
    });
    const firstPlace = places.length > 0 ? places[0] : null;

    return NextResponse.json({
      success: true,
      status: post.status,
      socialPostId: post.id,
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
