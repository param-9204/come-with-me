import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { v4 as uuidv4 } from 'uuid';

export const maxDuration = 60; // Allow Vercel function to run up to 60 seconds (requires Pro tier or compatible runtime)

async function runSynchronousPipeline(origin: string, url: string, socialPostId: string, userId?: string): Promise<string> {
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
      if (isVideo) {
        const duration = contentData.videoDuration || 15;
        const numFrames = Math.min(30, Math.round(duration));
        const timestamps: { index: number; timestamp: number }[] = [];
        const interval = duration / numFrames;
        for (let i = 0; i < numFrames; i++) {
          const ts = i * interval;
          if (ts < duration) {
            timestamps.push({ index: i, timestamp: ts });
          }
        }

        const ocrPromises = timestamps.map(async (item) => {
          try {
            const res = await fetch(`${origin}/api/process-url/ocr-frame`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                videoUrl: contentData.videoUrl,
                frameIndex: item.index,
                timestamp: item.timestamp,
                isVideo: true,
              }),
            });
            const resData = await res.json();
            if (res.ok && resData.success && resData.ocrFrameResult) {
              return resData.ocrFrameResult;
            }
          } catch (e) {
            console.error(`Frame OCR error for index ${item.index}:`, e);
          }
          return null;
        });
        const rawOcr = await Promise.all(ocrPromises);
        ocrResultsList = rawOcr.filter(Boolean);
      } else {
        const imageUrls =
          contentData.images && contentData.images.length > 0
            ? contentData.images
            : [contentData.displayUrl || contentData.videoUrl].filter(
              Boolean
            ) as string[];

        if (imageUrls.length > 0) {
          const ocrPromises = imageUrls.map(async (imageUrl: string, index: number) => {
            try {
              const res = await fetch(`${origin}/api/process-url/ocr-frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  imageUrl,
                  frameIndex: index,
                  isVideo: false,
                }),
              });
              const resData = await res.json();
              if (res.ok && resData.success && resData.ocrFrameResult) {
                return resData.ocrFrameResult;
              }
            } catch (e) {
              console.error(`Image OCR error for index ${index}:`, e);
            }
            return null;
          });
          const rawOcr = await Promise.all(ocrPromises);
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
    return analyzeData.socialPostId || socialPostId;
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
    const { url, userId } = await request.json();

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
      let places: any[] = [];
      if (existingPost.place_id) {
        const { data: primaryData } = await supabaseAdmin
          .from('places')
          .select('*')
          .eq('id', existingPost.place_id)
          .maybeSingle();
        if (primaryData) {
          places.push(primaryData);
        }
      }

      if (existingPost.post_url) {
        const { data: secondaryData } = await supabaseAdmin
          .from('places')
          .select('*')
          .eq('source_url', existingPost.post_url);
        if (secondaryData) {
          for (const p of secondaryData) {
            if (!places.some(x => x.id === p.id)) {
              places.push(p);
            }
          }
        }
      }

      return NextResponse.json({
        success: true,
        socialPostId: existingPost.id,
        data: existingPost,
        places
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
          user_id: userId || null
        })
        .select('id')
        .single();

      if (dbError || !socialPost) {
        throw new Error(`Failed to create database placeholder: ${dbError?.message}`);
      }
      socialPostId = socialPost.id;
    }

    // Execute the pipeline synchronously and await completion
    const finalPostId = await runSynchronousPipeline(origin, cleanUrl, socialPostId, userId);

    // Fetch and return the completed social post record
    const { data: completedPost, error: fetchErr } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .eq('id', finalPostId)
      .single();

    if (fetchErr || !completedPost) {
      throw new Error(`Failed to fetch completed post: ${fetchErr?.message}`);
    }

    let places: any[] = [];
    if (completedPost.place_id) {
      const { data: primaryData } = await supabaseAdmin
        .from('places')
        .select('*')
        .eq('id', completedPost.place_id)
        .maybeSingle();
      if (primaryData) {
        places.push(primaryData);
      }
    }

    if (completedPost.post_url) {
      const { data: secondaryData } = await supabaseAdmin
        .from('places')
        .select('*')
        .eq('source_url', completedPost.post_url);
      if (secondaryData) {
        for (const p of secondaryData) {
          if (!places.some(x => x.id === p.id)) {
            places.push(p);
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      socialPostId: completedPost.id,
      data: completedPost,
      places
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

    // Fetch all places linked to this post (primary place_id + secondary post_url matches)
    let places: any[] = [];
    if (post.place_id) {
      const { data: primaryData } = await supabaseAdmin
        .from('places')
        .select('*')
        .eq('id', post.place_id)
        .maybeSingle();
      if (primaryData) {
        places.push(primaryData);
      }
    }

    if (post.post_url) {
      const { data: secondaryData } = await supabaseAdmin
        .from('places')
        .select('*')
        .eq('source_url', post.post_url);
      if (secondaryData) {
        for (const p of secondaryData) {
          if (!places.some(x => x.id === p.id)) {
            places.push(p);
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      status: post.status,
      data: post,
      places
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
