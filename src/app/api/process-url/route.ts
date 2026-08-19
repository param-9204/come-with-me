import { NextResponse } from 'next/server';
import * as nextServer from 'next/server';

// Resolve waitUntil safely without triggering TypeScript or Turbopack module resolution warnings
const waitUntil = (nextServer as any).waitUntil || ((promise: Promise<any>) => {
  promise.catch((err) => console.error('[Background Pipeline] Uncaught error:', err));
});

async function runBackgroundPipeline(origin: string, url: string, userId?: string) {
  console.log(`[Background Pipeline] Starting process-url for: ${url} (origin: ${origin})`);
  try {
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

    const isVideo =
      !!contentData.videoUrl &&
      (contentData.contentType === 'video' ||
        contentData.contentType === 'reel');

    let whisperTranscript = '';
    let audioUploadObj: any = null;
    let ocrResultsList: any[] = [];

    // 2. Transcribe (if video)
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
          console.warn('[Background Pipeline] Transcription failed, proceeding:', err.message);
        }
      }
    })();

    // 3. OCR Promise
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

    // Run transcribe and OCR in parallel
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
      }),
    });

    const analyzeData = await analyzeRes.json();
    if (!analyzeRes.ok || !analyzeData.success) {
      throw new Error(analyzeData.error || 'Failed to complete analysis');
    }

    console.log(`[Background Pipeline] Finished processing successfully for: ${url}`);
  } catch (err: any) {
    console.error(`[Background Pipeline] Error processing: ${url}`, err.message);
  }
}

export async function POST(request: Request) {
  try {
    const { url, userId } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    let origin = new URL(request.url).origin;
    // Force HTTP on localhost (since Next.js dev server only listens on HTTP)
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      origin = origin.replace('https://', 'http://');
    }

    // Run the pipeline asynchronously in the background
    waitUntil(runBackgroundPipeline(origin, url, userId));

    return NextResponse.json({
      success: true,
      message: 'Processing started in the background.'
    });
  } catch (error: any) {
    console.error('[Process URL API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
