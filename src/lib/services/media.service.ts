import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface CacheEntry {
  filePath: string;
  promise: Promise<string>;
  refCount: number;
}

export class MediaService {
  private static cache = new Map<string, CacheEntry>();

  private static async fetchWithRetry(url: string, isVideo: boolean, maxRetries = 3): Promise<Response> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const headers: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.instagram.com/',
          'Sec-Fetch-Dest': isVideo ? 'video' : 'image',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
        };

        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok && response.body) {
          return response;
        }

        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          console.warn(
            `[MediaService] Fetch status ${response.status} for ${url.slice(0, 60)} (attempt ${attempt}/${maxRetries})`
          );
        } else {
          throw new Error(`Failed to fetch media from ${url}: HTTP ${response.status}`);
        }
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[MediaService] Download attempt ${attempt}/${maxRetries} failed for ${url.slice(0, 60)}: ${err.message || err}`
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    throw lastError || new Error(`Failed to fetch media from ${url}`);
  }

  static async downloadVideo(url: string): Promise<string> {
    const existing = this.cache.get(url);
    if (existing) {
      if (fs.existsSync(existing.filePath)) {
        existing.refCount++;
        return existing.promise;
      } else {
        this.cache.delete(url);
      }
    }

    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const videoId = uuidv4();
    const filePath = path.join(tempDir, `${videoId}.mp4`);

    const downloadPromise = (async () => {
      try {
        const response = await this.fetchWithRetry(url, true);
        const fileStream = fs.createWriteStream(filePath);
        const reader = response.body!.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
        }

        fileStream.end();

        await new Promise<void>((resolve, reject) => {
          fileStream.on('finish', () => resolve());
          fileStream.on('error', (err) => reject(err));
        });

        return filePath;
      } catch (err) {
        this.cache.delete(url);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
        throw err;
      }
    })();

    this.cache.set(url, {
      filePath,
      promise: downloadPromise,
      refCount: 1,
    });

    return downloadPromise;
  }

  /**
   * Downloads an image from a URL to a temporary local file.
   */
  static async downloadImage(url: string): Promise<string> {
    const existing = this.cache.get(url);
    if (existing) {
      if (fs.existsSync(existing.filePath)) {
        existing.refCount++;
        return existing.promise;
      } else {
        this.cache.delete(url);
      }
    }

    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const imageId = uuidv4();
    const filePath = path.join(tempDir, `${imageId}.jpg`);

    const downloadPromise = (async () => {
      try {
        const response = await this.fetchWithRetry(url, false);
        const fileStream = fs.createWriteStream(filePath);
        const reader = response.body!.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
        }

        fileStream.end();

        await new Promise<void>((resolve, reject) => {
          fileStream.on('finish', () => resolve());
          fileStream.on('error', (err) => reject(err));
        });

        return filePath;
      } catch (err) {
        this.cache.delete(url);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
        throw err;
      }
    })();

    this.cache.set(url, {
      filePath,
      promise: downloadPromise,
      refCount: 1,
    });

    return downloadPromise;
  }

  /**
   * Extracts audio from an MP4 file and saves it as an MP3 file
   * suitable for Whisper API.
   */
  static async extractAudio(videoPath: string): Promise<string> {
    const audioPath = videoPath.replace('.mp4', '.mp3');

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .toFormat('mp3')
        .on('end', () => {
          resolve(audioPath);
        })
        .on('error', (err) => {
          if (err.message && err.message.includes('does not contain any stream')) {
            console.warn('FFmpeg Warning: No audio stream found in video. Skipping audio extraction.');
            resolve('');
          } else {
            console.error('Error extracting audio:', err);
            reject(err);
          }
        })
        .save(audioPath);
    });
  }

  /**
   * Cleans up temporary files
   */
  static cleanupFiles(filePaths: string[]) {
    filePaths.forEach((filePath) => {
      if (!filePath) return;

      let cachedUrl: string | null = null;
      let cachedEntry: CacheEntry | null = null;

      for (const [url, entry] of this.cache.entries()) {
        if (entry.filePath === filePath) {
          cachedUrl = url;
          cachedEntry = entry;
          break;
        }
      }

      if (cachedEntry && cachedUrl) {
        cachedEntry.refCount--;
        if (cachedEntry.refCount <= 0) {
          this.cache.delete(cachedUrl);
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch {}
          }
        }
      } else {
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
      }
    });
  }
}

