import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export class MediaService {
  static async downloadVideo(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch video from ${url}`);
    }

    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const videoId = uuidv4();
    const filePath = path.join(tempDir, `${videoId}.mp4`);

    const fileStream = fs.createWriteStream(filePath);
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
      }
    } finally {
      fileStream.end();
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve());
      fileStream.on('error', (err) => reject(err));
    });

    return filePath;
  }

  /**
   * Downloads an image from a URL to a temporary local file.
   */
  static async downloadImage(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch image from ${url}`);
    }

    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const imageId = uuidv4();
    const filePath = path.join(tempDir, `${imageId}.jpg`);

    const fileStream = fs.createWriteStream(filePath);
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
      }
    } finally {
      fileStream.end();
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve());
      fileStream.on('error', (err) => reject(err));
    });

    return filePath;
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
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  }
}
