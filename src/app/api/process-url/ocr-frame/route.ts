import { NextResponse } from 'next/server';
import fs from 'fs';
import crypto from 'crypto';
import { MediaService } from '@/lib/services/media.service';
import { VideoFrameService } from '@/lib/services/video-frame.service';
import { ApifyOcrService } from '@/lib/services/apify-ocr.service';
import type { VideoFrame } from '@/lib/types/social';

export async function POST(request: Request) {
  let tempMediaPath = '';
  let tempFramePath = '';

  try {
    const body = await request.json();
    const { videoUrl, imageUrl, frameIndex, timestamp, isVideo } = body;

    const idx = typeof frameIndex === 'number' ? frameIndex : 0;
    const ts = typeof timestamp === 'number' ? timestamp : 0;

    console.log(`[API OCR-Frame] Processing frame index ${idx} (isVideo: ${isVideo})`);

    let localFramePath = '';

    if (isVideo) {
      if (!videoUrl || typeof videoUrl !== 'string') {
        return NextResponse.json({ error: 'Missing required field: videoUrl' }, { status: 400 });
      }

      // 1. Download video
      tempMediaPath = await MediaService.downloadVideo(videoUrl);
      if (!tempMediaPath) {
        throw new Error('Failed to download video file.');
      }

      // 2. Extract single frame
      tempFramePath = await VideoFrameService.extractSingleFrame(tempMediaPath, ts);
      localFramePath = tempFramePath;
    } else {
      if (!imageUrl || typeof imageUrl !== 'string') {
        return NextResponse.json({ error: 'Missing required field: imageUrl' }, { status: 400 });
      }

      // 1. Download image
      tempMediaPath = await MediaService.downloadImage(imageUrl);
      if (!tempMediaPath) {
        throw new Error('Failed to download image file.');
      }
      localFramePath = tempMediaPath;
    }

    // 3. Create virtual VideoFrame object
    const buffer = fs.readFileSync(/*turbopackIgnore: true*/ localFramePath);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');

    const virtualFrame: VideoFrame = {
      frameIndex: idx,
      timestamp: ts,
      filePath: localFramePath,
      hash,
    };

    // 4. Run local Tesseract OCR on the single frame
    const ocrResults = await ApifyOcrService.extractTextFromFrames([virtualFrame], false);
    
    // 5. Clean up local files immediately
    MediaService.cleanupFiles([tempMediaPath, tempFramePath].filter(Boolean));

    const result = ocrResults.length > 0 ? ocrResults[0] : null;

    return NextResponse.json({
      success: true,
      ocrFrameResult: result,
    });

  } catch (error: any) {
    console.error(`[API OCR-Frame] Error processing frame index:`, error);

    // Attempt cleanup on error
    try {
      MediaService.cleanupFiles([tempMediaPath, tempFramePath].filter(Boolean));
    } catch (cleanupErr) {
      console.error('[API OCR-Frame] Cleanup error:', cleanupErr);
    }

    return NextResponse.json({
      success: false,
      error: error.message || 'Frame OCR processing failed',
    }, { status: 500 });
  }
}
