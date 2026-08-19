import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export class MediaService {
  /**
   * Downloads a video from a URL to a temporary local file.
   * Note: In a production R&D setup, this might use ytdl-core or fetch
   * depending on the scraped video source. For this basic setup,
   * we'll simulate downloading by assuming the URL is a direct MP4 link
   * and fetching it.
   */
  static async downloadVideo(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch video from ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const videoId = uuidv4();
    const filePath = path.join(tempDir, `${videoId}.mp4`);
    
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  /**
   * Downloads an image from a URL to a temporary local file.
   */
  static async downloadImage(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const imageId = uuidv4();
    const filePath = path.join(tempDir, `${imageId}.jpg`);
    
    fs.writeFileSync(filePath, buffer);
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
