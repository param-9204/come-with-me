import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { VideoFrameService } from '../video-frame.service';

describe('VideoFrameService.planKeyFrames', () => {
  it('samples one frame per second with no cap by default', () => {
    expect(VideoFrameService.planKeyFrames(15)).toEqual({ intervalSec: 1, maxFrames: Number.POSITIVE_INFINITY });
    expect(VideoFrameService.planKeyFrames(600)).toEqual({ intervalSec: 1, maxFrames: Number.POSITIVE_INFINITY });
  });

  it('respects an explicit cap (OCR_MAX_KEY_FRAMES)', () => {
    expect(VideoFrameService.planKeyFrames(60, 10).maxFrames).toBe(10);
  });

  it('spreads a capped selection evenly and keeps both ends', () => {
    expect(VideoFrameService.spreadEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(VideoFrameService.spreadEvenly([1, 2], Number.POSITIVE_INFINITY)).toEqual([1, 2]);
  });
});

const ffmpegAvailable = spawnSync(ffmpegInstaller.path, ['-version']).status === 0;

describe.skipIf(!ffmpegAvailable)('VideoFrameService.extractKeyFrames (ffmpeg)', () => {
  it('returns one frame for every second, including static stretches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-test-'));
    const video = path.join(dir, 'scenes.mp4');
    // 3s red, 3s blue, 6s static green, 3s grey = 15 s.
    const result = spawnSync(ffmpegInstaller.path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=360x640:d=3:r=30',
      '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:d=3:r=30',
      '-f', 'lavfi', '-i', 'color=c=green:s=360x640:d=6:r=30',
      '-f', 'lavfi', '-i', 'color=c=gray:s=360x640:d=3:r=30',
      '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p',
      video,
    ]);
    expect(result.status).toBe(0);

    expect(Math.round(await VideoFrameService.getVideoDuration(video))).toBe(15);
    const frames = await VideoFrameService.extractKeyFrames(video);
    try {
      expect(frames).toHaveLength(15);
      frames.forEach((frame, second) => {
        expect(frame.timestamp).toBeCloseTo(second, 0);
        expect(fs.existsSync(frame.filePath)).toBe(true);
        expect(fs.existsSync(frame.colorFilePath!)).toBe(true);
      });
    } finally {
      VideoFrameService.cleanupFrames(frames);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
