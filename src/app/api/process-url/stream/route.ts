import { supabaseAdmin } from '@/lib/supabase';
import { v4 as uuidv4 } from 'uuid';
import { after } from 'next/server';
import { ScraperService } from '@/lib/services/scraper.service';

export const maxDuration = 300; // Requires Vercel Pro / Fluid Compute

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
    const contentType: string = contentData.contentType || 'reel';
    const isVideo = !!contentData.videoUrl && (contentType === 'video' || contentType === 'reel');
    const isCarousel =
      contentType === 'sidecar' ||
      (Array.isArray(contentData.images) && contentData.images.length > 1);

    let whisperTranscript = '';
    let audioUploadObj: any = null;
    let ocrResultsList: any[] = [];

    // ── BRANCH A: Video / Reel — download video ONCE, share between OCR + Whisper ──
    if (isVideo && contentData.videoUrl) {
      const { MediaService } = await import('@/lib/services/media.service');
      const { VideoFrameService } = await import('@/lib/services/video-frame.service');
      const { ApifyOcrService } = await import('@/lib/services/apify-ocr.service');
      const { WhisperService } = await import('@/lib/services/whisper.service');
      const { S3Service } = await import('@/lib/services/s3.service');
      const fs = await import('fs');
      const path = await import('path');

      const duration = contentData.videoDuration || 15;
      const maxFrames = duration <= 15 ? 3 : duration <= 30 ? 5 : 6;

      console.log(`[Background Pipeline] Downloading video once (duration=${duration}s, maxFrames=${maxFrames})...`);
      const tempVideoPath = await MediaService.downloadVideo(contentData.videoUrl);

      try {
        // ── Parallel: extract frames + extract audio from the same /tmp file ──
        const [frames, tempAudioPath] = await Promise.all([
          VideoFrameService.extractFrames(tempVideoPath, maxFrames).catch(() => []),
          MediaService.extractAudio(tempVideoPath).catch(() => null),
        ]);

        console.log(`[Background Pipeline] Got ${frames.length} frames + audio. Running Tesseract + Whisper in parallel...`);

        // ── Parallel: Tesseract OCR on frames + Whisper on audio ──────────────
        const [ocrResults, whisperResult] = await Promise.all([
          ApifyOcrService.extractTextFromFrames(frames, false).catch((err: any) => {
            console.warn('[Background Pipeline] OCR failed (non-fatal):', err.message);
            return [];
          }),
          tempAudioPath
            ? WhisperService.processAudio(tempAudioPath).catch((err: any) => {
                console.warn('[Background Pipeline] Whisper failed (non-fatal):', err.message);
                return null;
              })
            : Promise.resolve(null),
        ]);

        ocrResultsList = ocrResults.filter(Boolean);

        if (whisperResult) {
          whisperTranscript = `Original Transcript:\n${whisperResult.originalTranscript}\n\nEnglish Translation:\n${whisperResult.englishTranscript}`;
        }

        // ── Upload audio to S3, register in DB ────────────────────────────────
        if (tempAudioPath && fs.default.existsSync(tempAudioPath)) {
          try {
            const fileStats = fs.default.statSync(tempAudioPath);
            const fileName = path.default.basename(tempAudioPath);
            const audioUuid = uuidv4();

            if (
              process.env.AWS_ACCESS_KEY_ID &&
              process.env.AWS_SECRET_ACCESS_KEY &&
              process.env.AWS_S3_BUCKET_NAME
            ) {
              const fileBuffer = fs.default.readFileSync(tempAudioPath);
              const s3Url = await S3Service.uploadAudio(fileBuffer, fileName, 'audio/mpeg');
              const { data: dbData } = await supabaseAdmin
                .from('audio_uploads')
                .insert({
                  social_post_id: null,
                  file_name: fileName,
                  storage_path: `uploads/${fileName}`,
                  public_url: s3Url,
                  mime_type: 'audio/mpeg',
                  size_bytes: fileStats.size,
                })
                .select('id, file_name, size_bytes, public_url')
                .single();
              if (dbData) {
                audioUploadObj = { id: dbData.id, fileName: dbData.file_name, sizeBytes: dbData.size_bytes, publicUrl: dbData.public_url };
                console.log('[Background Pipeline] Audio → S3 + DB:', dbData.id);
              }
            } else {
              // Local fallback
              const publicAudioDir = path.default.join(process.cwd(), 'public', 'audio');
              if (!fs.default.existsSync(publicAudioDir)) fs.default.mkdirSync(publicAudioDir, { recursive: true });
              const localFileName = `${audioUuid}.mp3`;
              fs.default.copyFileSync(tempAudioPath, path.default.join(publicAudioDir, localFileName));
              audioUploadObj = { id: audioUuid, fileName, sizeBytes: fileStats.size, publicUrl: `/audio/${localFileName}` };
              console.log('[Background Pipeline] Audio saved locally:', audioUploadObj.publicUrl);
            }
          } catch (audioErr: any) {
            console.warn('[Background Pipeline] Audio upload failed (non-fatal):', audioErr.message);
          }
        }

        // ── Cleanup frames + audio AFTER both branches finish ─────────────────
        VideoFrameService.cleanupFrames(frames);
        MediaService.cleanupFiles(tempAudioPath ? [tempAudioPath] : []);
      } finally {
        // Always cleanup the shared video file last
        MediaService.cleanupFiles([tempVideoPath]);
      }

    // ── BRANCH B: Carousel / Sidecar — support mixed carousel images + videos ──
    } else if (isCarousel) {
      const childPosts = (rawApifyDataObj?.childPosts || []) as any[];

      if (childPosts.length > 0) {
        console.log(`[Background Pipeline] Mixed Carousel: Processing ${Math.min(childPosts.length, 4)} slides...`);
        const { MediaService } = await import('@/lib/services/media.service');
        const { VideoFrameService } = await import('@/lib/services/video-frame.service');
        const { ApifyOcrService } = await import('@/lib/services/apify-ocr.service');
        const { WhisperService } = await import('@/lib/services/whisper.service');
        const fs = await import('fs');
        const crypto = await import('crypto');

        const slidePromises = childPosts.slice(0, 4).map(async (child, index) => {
          const isSlideVideo = child.type === 'Video' || !!child.videoUrl;

          if (isSlideVideo && child.videoUrl) {
            console.log(`[Background Pipeline] Carousel Slide ${index} is Video. Processing...`);
            const tempVideoPath = await MediaService.downloadVideo(child.videoUrl).catch(() => null);
            if (!tempVideoPath) return null;

            try {
              const [frames, tempAudioPath] = await Promise.all([
                VideoFrameService.extractFrames(tempVideoPath, 2).catch(() => []),
                MediaService.extractAudio(tempVideoPath).catch(() => null)
              ]);

              const [ocrResults, whisperResult] = await Promise.all([
                ApifyOcrService.extractTextFromFrames(frames, false).catch(() => []),
                tempAudioPath ? WhisperService.processAudio(tempAudioPath).catch(() => null) : Promise.resolve(null)
              ]);

              VideoFrameService.cleanupFrames(frames);
              if (tempAudioPath) MediaService.cleanupFiles([tempAudioPath]);

              return {
                type: 'video',
                ocr: ocrResults.filter(Boolean),
                transcript: whisperResult ? `Slide ${index} Transcript:\n${whisperResult.originalTranscript}\n` : ''
              };
            } catch (err: any) {
              console.warn(`[Background Pipeline] Carousel slide ${index} video processing failed:`, err.message);
              return null;
            } finally {
              MediaService.cleanupFiles([tempVideoPath]);
            }
          } else {
            const imgUrl = child.displayUrl || child.url;
            if (imgUrl) {
              console.log(`[Background Pipeline] Carousel Slide ${index} is Image. Processing...`);
              try {
                const filePath = await MediaService.downloadImage(imgUrl);
                const buffer = fs.default.readFileSync(filePath);
                const hash = crypto.default.createHash('md5').update(buffer).digest('hex');
                const frames = [{ frameIndex: index, timestamp: 0, filePath, hash }];

                const ocrResults = await ApifyOcrService.extractTextFromFrames(frames as any, false).catch(() => []);
                MediaService.cleanupFiles([filePath]);

                return {
                  type: 'image',
                  ocr: ocrResults.filter(Boolean),
                  transcript: ''
                };
              } catch (err: any) {
                console.warn(`[Background Pipeline] Carousel slide ${index} image processing failed:`, err.message);
                return null;
              }
            }
          }
          return null;
        });

        const slideResults = (await Promise.all(slidePromises)).filter(Boolean);

        const ocrCombined: any[] = [];
        let mergedTranscript = '';
        for (const res of slideResults) {
          if (res) {
            ocrCombined.push(...res.ocr);
            if (res.transcript) {
              mergedTranscript += res.transcript + '\n';
            }
          }
        }
        ocrResultsList = ocrCombined;
        whisperTranscript = mergedTranscript.trim();
      } else {
        const imageUrls: string[] =
          Array.isArray(contentData.images) && contentData.images.length > 0
            ? contentData.images
            : [contentData.displayUrl].filter(Boolean) as string[];

        if (imageUrls.length > 0) {
          try {
            const { MediaService } = await import('@/lib/services/media.service');
            const { ApifyOcrService } = await import('@/lib/services/apify-ocr.service');
            const fs = await import('fs');
            const crypto = await import('crypto');

            console.log(`[Background Pipeline] Carousel fallback: OCR on ${Math.min(imageUrls.length, 6)} images...`);

            const frames: { frameIndex: number; timestamp: number; filePath: string; hash: string }[] =
              await Promise.all(
                imageUrls.slice(0, 6).map(async (imageUrl: string, index: number) => {
                  const filePath = await MediaService.downloadImage(imageUrl);
                  const buffer = fs.default.readFileSync(filePath);
                  const hash = crypto.default.createHash('md5').update(buffer).digest('hex');
                  return { frameIndex: index, timestamp: 0, filePath, hash };
                })
              );

            const ocrResults = await ApifyOcrService.extractTextFromFrames(frames as any, false).catch(() => []);
            ocrResultsList = ocrResults.filter(Boolean);
            MediaService.cleanupFiles(frames.map((f) => f.filePath));
          } catch (err: any) {
            console.warn('[Background Pipeline] Carousel OCR failed (non-fatal):', err.message);
          }
        }
      }

    // ── BRANCH C: Single Image Post ────────────────────────────────────────────
    } else {
      const imageUrl = contentData.displayUrl || contentData.videoUrl;
      if (imageUrl) {
        try {
          const { MediaService } = await import('@/lib/services/media.service');
          const { ApifyOcrService } = await import('@/lib/services/apify-ocr.service');
          const fs = await import('fs');
          const crypto = await import('crypto');

          console.log(`[Background Pipeline] Single image: OCR...`);
          const filePath = await MediaService.downloadImage(imageUrl);
          const buffer = fs.default.readFileSync(filePath);
          const hash = crypto.default.createHash('md5').update(buffer).digest('hex');
          const frames = [{ frameIndex: 0, timestamp: 0, filePath, hash }];

          const ocrResults = await ApifyOcrService.extractTextFromFrames(frames as any, false).catch(() => []);
          ocrResultsList = ocrResults.filter(Boolean);
          MediaService.cleanupFiles([filePath]);
        } catch (err: any) {
          console.warn('[Background Pipeline] Single image OCR failed (non-fatal):', err.message);
        }
      }
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
        apifyOcrFrames: ocrResultsList,
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
              user_id: userId || null,
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
                  ? ScraperService.normalizeTikTokRaw(rawApifyDataObj)
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
              } catch (_) {}
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
              let places: any[] = [];
              if (dbPost.place_id) {
                const { data: primaryData } = await supabaseAdmin
                  .from('places')
                  .select('*')
                  .eq('id', dbPost.place_id)
                  .maybeSingle();
                if (primaryData) {
                  places.push(primaryData);
                }
              }

              if (dbPost.post_url) {
                const { data: secondaryData } = await supabaseAdmin
                  .from('places')
                  .select('*')
                  .eq('source_url', dbPost.post_url);
                if (secondaryData) {
                  for (const p of secondaryData) {
                    if (!places.some(x => x.id === p.id)) {
                      places.push(p);
                    }
                  }
                }
              }

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
