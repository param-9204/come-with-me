import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import crypto from 'crypto';
import type { VideoFrame } from '../types/social';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export class VideoFrameService {
  /**
   * Get video duration in seconds using ffprobe
   */
  static async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.warn('[VideoFrame] ffprobe failed, defaulting duration to 60s:', err.message);
          resolve(60);
        } else {
          resolve(metadata.format.duration || 60);
        }
      });
    });
  }

  static async extractFrames(videoPath: string, maxFrames = 12): Promise<VideoFrame[]> {
    const sessionId = uuidv4();
    const framesDir = path.join(os.tmpdir(), `frames_${sessionId}`);
    fs.mkdirSync(framesDir, { recursive: true });

    const duration = await this.getVideoDuration(videoPath);

    // Extract 1 frame every 5 seconds — spreads coverage across the full video.
    // A 60s reel gives 12 frames (0s,5s,10s,15s...55s).
    // A 3-minute video gives 36 frames — capped by maxFrames.
    const FRAME_INTERVAL_SEC = 1;
    const targetFps = 1 / FRAME_INTERVAL_SEC;  // 0.2 fps
    const outputPattern = path.join(framesDir, 'frame_%04d.jpg');

    console.log(`[VideoFrame] Extracting 1 frame every ${FRAME_INTERVAL_SEC}s (duration=${duration.toFixed(1)}s, max=${maxFrames} frames)...`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          // Select frames at target fps, upscale/preserve HD, make grayscale, boost contrast, and sharpen edges for OCR
          `-vf select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${(1 / targetFps).toFixed(2)})',scale=1280:-2,format=gray,eq=contrast=1.5,unsharp=5:5:1.0`,
          '-vsync vfr',
          '-q:v 3',         // JPEG quality (1=best, 31=worst)
        ])
        .output(outputPattern)
        .on('end', () => resolve())
        .on('error', (err) => {
          // Fallback: try simpler fps approach without scene detection
          console.warn('[VideoFrame] Advanced filter failed, using simple fps:', err.message);
          ffmpeg(videoPath)
            .outputOptions([`-vf fps=${targetFps.toFixed(3)},scale=1280:-2,format=gray,eq=contrast=1.5,unsharp=5:5:1.0`, '-q:v 3'])
            .output(outputPattern)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        })
        .run();
    });

    // Read frames from disk
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort();

    const frames: VideoFrame[] = [];
    const seenHashes = new Set<string>();

    for (let i = 0; i < frameFiles.length; i++) {
      const filePath = path.join(framesDir, frameFiles[i]);

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch {
        continue;
      }

      const hash = crypto.createHash('md5').update(buffer).digest('hex');

      // Skip near-duplicate frames (same pixel content)
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      // Extract the frame number from filename to get the exact timestamp
      const match = frameFiles[i].match(/frame_(\d+)\.jpg/);
      const frameNum = match ? parseInt(match[1], 10) : i + 1;
      const timestamp = Math.min((frameNum - 1) * FRAME_INTERVAL_SEC, duration);

      frames.push({ frameIndex: i, timestamp, filePath, hash });

      if (frames.length >= maxFrames) break;
    }

    console.log(`[VideoFrame] Extracted ${frames.length} unique frames from ${frameFiles.length} total`);
    return frames;
  }

  /**
   * Extract a single enhanced frame at a specific timestamp
   */
  static async extractSingleFrame(videoPath: string, timestamp: number): Promise<string> {
    const sessionId = uuidv4();
    const outputPath = path.join(os.tmpdir(), `frame_${sessionId}_${timestamp.toFixed(2)}.jpg`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions([
          '-frames:v 1',
          '-vf scale=1280:-2,format=gray,eq=contrast=1.5,unsharp=5:5:1.0',
          '-q:v 3'
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => {
          // Fallback simple extract
          console.warn(`[VideoFrame] Enhanced extract failed for timestamp ${timestamp}, trying simple:`, err.message);
          ffmpeg(videoPath)
            .seekInput(timestamp)
            .outputOptions(['-frames:v 1', '-q:v 3'])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        })
        .run();
    });

    return outputPath;
  }

  /**
   * Clean up the entire frames directory for a session
   */
  static cleanupFrames(frames: VideoFrame[]) {
    if (frames.length === 0) return;
    const dir = path.dirname(frames[0].filePath);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[VideoFrame] Cleaned up frames dir: ${dir}`);
    } catch (e) {
      console.warn('[VideoFrame] Cleanup warning:', e);
    }
  }
}
