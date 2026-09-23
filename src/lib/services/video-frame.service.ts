import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import crypto from 'crypto';
import { spawn } from 'child_process';
import type { VideoFrame } from '../types/social';
import { errorMessage, plog } from './pipeline-log';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface KeyFramePlan {
  /** Seconds between frames: one frame per second. */
  intervalSec: number;
  /** No cap by default; OCR_MAX_KEY_FRAMES sets one (frames are then spread evenly). */
  maxFrames: number;
}

export class VideoFrameService {
  /**
   * One frame for every second of video — a 90 s video gives 90 frames — with
   * no cap and no duplicate removal, so nothing shown on screen is skipped.
   * OCR_MAX_KEY_FRAMES may set a cap if run time ever needs bounding.
   */
  static planKeyFrames(_durationSec: number, maxFramesOverride?: number): KeyFramePlan {
    const maxFrames = maxFramesOverride && maxFramesOverride > 0 ? maxFramesOverride : Number.POSITIVE_INFINITY;
    return { intervalSec: 1, maxFrames };
  }

  /** Evenly spread selection that always keeps the first and last item. */
  static spreadEvenly<T>(items: T[], max: number): T[] {
    if (items.length <= max) return items;
    if (max <= 1) return items.slice(0, Math.max(0, max));
    const step = (items.length - 1) / (max - 1);
    const picked = new Set<number>();
    for (let i = 0; i < max; i++) picked.add(Math.round(i * step));
    return [...picked].sort((a, b) => a - b).map((index) => items[index]);
  }

  /**
   * One ffmpeg pass samples one frame per second and writes (a) a colour frame
   * for vision OCR and (b) an enhanced grayscale frame for Tesseract. Frames
   * are never upscaled; width is capped at 1280.
   */
  static async extractKeyFrames(videoPath: string, plan?: Partial<KeyFramePlan>): Promise<VideoFrame[]> {
    const duration = await this.getVideoDuration(videoPath);
    const envMax = Number(process.env.OCR_MAX_KEY_FRAMES) || undefined;
    const resolved: KeyFramePlan = { ...this.planKeyFrames(duration, envMax), ...plan };
    const framesDir = path.join(os.tmpdir(), `frames_${uuidv4()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    const scale = "scale='min(1280,iw)':-2";
    const filter =
      `[0:v]fps=${1 / resolved.intervalSec},showinfo,split=2[c][o];` +
      `[c]${scale}[cout];` +
      `[o]${scale},format=gray,eq=contrast=1.5,unsharp=5:5:1.0[oout]`;
    const args = [
      '-hide_banner', '-nostats', '-i', videoPath,
      '-filter_complex', filter,
      '-map', '[cout]', '-vsync', 'vfr', '-q:v', '3', path.join(framesDir, 'color_%05d.jpg'),
      '-map', '[oout]', '-vsync', 'vfr', '-q:v', '3', path.join(framesDir, 'ocr_%05d.jpg'),
    ];

    let timestamps: number[];
    try {
      timestamps = await new Promise<number[]>((resolve, reject) => {
        const found: number[] = [];
        let stderrTail = '';
        const child = spawn(ffmpegInstaller.path, args, { windowsHide: true });
        child.stderr.on('data', (chunk: Buffer) => {
          const textChunk = stderrTail + chunk.toString();
          const lines = textChunk.split(/\r?\n/);
          stderrTail = lines.pop() || '';
          for (const line of lines) {
            if (!line.includes('Parsed_showinfo')) continue;
            const match = line.match(/pts_time:\s*([\d.]+)/);
            if (match) found.push(Number(match[1]));
          }
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(found) : reject(new Error(`ffmpeg exited with ${code}: ${stderrTail.slice(-300)}`))));
      });
    } catch (error) {
      plog('frames', 'Frame pass failed; falling back to the simple 1 fps extractor', { error: errorMessage(error) }, 'warn');
      fs.rmSync(framesDir, { recursive: true, force: true });
      return this.extractFrames(videoPath, resolved.maxFrames, resolved.intervalSec);
    }

    const colorFiles = fs.readdirSync(framesDir).filter((f) => f.startsWith('color_')).sort();
    const ocrFiles = fs.readdirSync(framesDir).filter((f) => f.startsWith('ocr_')).sort();
    const count = Math.min(colorFiles.length, ocrFiles.length);
    const selected = new Set(this.spreadEvenly(Array.from({ length: count }, (_, i) => i), resolved.maxFrames));

    const frames: VideoFrame[] = [];
    for (let i = 0; i < Math.max(colorFiles.length, ocrFiles.length); i++) {
      const colorPath = colorFiles[i] ? path.join(framesDir, colorFiles[i]) : '';
      const ocrPath = ocrFiles[i] ? path.join(framesDir, ocrFiles[i]) : '';
      if (i < count && selected.has(i)) {
        frames.push({
          frameIndex: frames.length,
          timestamp: Math.min(timestamps[i] ?? i * resolved.intervalSec, duration),
          filePath: ocrPath,
          colorFilePath: colorPath,
          hash: crypto.createHash('md5').update(fs.readFileSync(ocrPath)).digest('hex'),
        });
      } else {
        for (const file of [colorPath, ocrPath]) if (file) fs.rmSync(file, { force: true });
      }
    }

    plog('frames', 'Frames sampled (1 per second)', {
      durationSec: Math.round(duration * 10) / 10,
      frames: frames.length,
      ...(Number.isFinite(resolved.maxFrames) ? { cap: resolved.maxFrames } : {}),
    });
    if (frames.length === 0) fs.rmSync(framesDir, { recursive: true, force: true });
    return frames;
  }

  /**
   * Get video duration in seconds using ffprobe
   */
  static async getVideoDuration(videoPath: string): Promise<number> {
    const probed = await new Promise<number | null>((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => resolve(err ? null : metadata?.format?.duration || null));
    });
    if (probed) return probed;
    // ffprobe is not bundled at runtime; `ffmpeg -i` prints "Duration: HH:MM:SS.ms".
    const parsed = await new Promise<number | null>((resolve) => {
      let stderr = '';
      const child = spawn(ffmpegInstaller.path, ['-hide_banner', '-i', videoPath], { windowsHide: true });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null);
      });
    });
    if (parsed) return parsed;
    plog('frames', 'Could not read video duration; defaulting to 60s', undefined, 'warn');
    return 60;
  }

  /** Fixed-interval sampling. Used as the fallback when the key-frame pass fails. */
  static async extractFrames(videoPath: string, maxFrames = 120, intervalSec = 1): Promise<VideoFrame[]> {
    const sessionId = uuidv4();
    const framesDir = path.join(os.tmpdir(), `frames_${sessionId}`);
    fs.mkdirSync(framesDir, { recursive: true });

    const duration = await this.getVideoDuration(videoPath);

    const FRAME_INTERVAL_SEC = intervalSec;
    const targetFps = 1 / FRAME_INTERVAL_SEC;
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
