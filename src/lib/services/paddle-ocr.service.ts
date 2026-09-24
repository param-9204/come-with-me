import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ApifyOcrFrameResult, OcrLine, VideoFrame } from '../types/social';
import { errorMessage, plog } from './pipeline-log';

/**
 * PP-OCRv6 model sizes. Measured on the 12-frame ZTUK2mcXV reel (720p, this
 * machine): tiny ~330 ms/frame, small ~650 ms/frame, medium ~1.9 s/frame.
 * All three read the 5 restaurant labels Tesseract missed; small had the
 * fewest garbled copies, medium added more junk lines.
 */
type ModelSize = 'tiny' | 'small' | 'medium';

/** Same scale as Tesseract's word threshold (0–100), so vision escalation treats both engines alike. */
const WORD_CONF_THRESHOLD = 60;
/** Lines below this confidence are dropped as noise (0–1). */
const MIN_LINE_CONFIDENCE = 0.5;
const DEFAULT_CONCURRENCY = 2;

interface PaddleWord { text?: string; confidence?: number }
interface PaddleResult { text?: string; lines?: PaddleWord[][]; confidence?: number }
interface PaddleEngine {
  initialize(): Promise<void>;
  recognize(image: ArrayBuffer, options?: { noCache?: boolean }): Promise<PaddleResult>;
  destroy(): Promise<void>;
}

/** Lines, confidences and word stats for one Paddle result, in the local-OCR shape. */
export function paddleFrameResult(frame: VideoFrame, result: PaddleResult): ApifyOcrFrameResult {
  const lines: OcrLine[] = [];
  const wordConfidences: number[] = [];
  for (const line of result.lines || []) {
    const words = line.filter((word) => (word.text || '').trim());
    if (words.length === 0) continue;
    const text = words.map((word) => word.text!.trim()).join(' ').replace(/\s+/g, ' ').trim();
    const confidence = words.reduce((sum, word) => sum + (word.confidence || 0), 0) / words.length;
    for (const token of text.split(' ')) if (/[\p{L}\p{N}]/u.test(token)) wordConfidences.push(confidence * 100);
    if (text.length >= 2 && confidence >= MIN_LINE_CONFIDENCE) lines.push({ text, confidence: Math.round(confidence * 100) / 100 });
  }
  const meanConfidence = wordConfidences.length ? wordConfidences.reduce((sum, value) => sum + value, 0) / wordConfidences.length : 0;
  return {
    frameIndex: frame.frameIndex,
    timestamp: frame.timestamp,
    texts: lines.map((line) => line.text),
    rawConfidence: result.confidence || 0,
    rawResult: { text: result.text || '', engine: 'paddle' },
    method: 'apify-ocr',
    lines,
    wordStats: {
      total: wordConfidences.length,
      confident: wordConfidences.filter((value) => value >= WORD_CONF_THRESHOLD).length,
      meanConfidence: Math.round(meanConfidence),
    },
  };
}

function modelSize(): ModelSize {
  const value = process.env.PADDLE_OCR_MODEL?.trim().toLowerCase();
  return value === 'tiny' || value === 'medium' ? value : 'small';
}

/** Model files are cached in a writable dir (os.tmpdir() by default; serverless allows only /tmp). */
async function loadModelFile(url: string): Promise<ArrayBuffer> {
  const dir = process.env.PADDLE_OCR_CACHE_DIR?.trim() || path.join(os.tmpdir(), 'ppu-paddle-ocr');
  const file = path.join(dir, path.basename(new URL(url).pathname));
  if (!fs.existsSync(file)) {
    plog('ocr', 'Downloading PaddleOCR model file', { file: path.basename(file) });
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`PaddleOCR model download failed (HTTP ${response.status}): ${url}`);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.part`;
    fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(tmp, file);
  }
  const buffer = fs.readFileSync(file);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

/**
 * Local PaddleOCR (PP-OCRv6 via ONNX Runtime). Free, no API calls after the
 * one-time model download. Reads the colour frame: detection works on the
 * original image, not the grey/contrast copy made for Tesseract.
 */
export class PaddleOcrService {
  private static engine: Promise<PaddleEngine> | null = null;
  private static engineSize: ModelSize | null = null;

  /** One engine per process; loading the models takes seconds. */
  private static async getEngine(): Promise<PaddleEngine> {
    const size = modelSize();
    if (!this.engine || this.engineSize !== size) {
      this.engineSize = size;
      this.engine = (async () => {
        const started = Date.now();
        const paddle = await import('ppu-paddle-ocr');
        const Engine = paddle.PaddleOcrService;
        // Model URLs come from the package presets (Hugging Face: snowfluke/ppu-paddle-ocr-models).
        const urls = { tiny: paddle.V6_TINY_MODEL, small: paddle.V6_SMALL_MODEL, medium: paddle.V6_MEDIUM_MODEL }[size] as { detection: string; recognition: string; charactersDictionary: string };
        const [detection, recognition, charactersDictionary] = await Promise.all([
          loadModelFile(urls.detection),
          loadModelFile(urls.recognition),
          loadModelFile(urls.charactersDictionary),
        ]);
        const engine = new Engine({ model: { detection, recognition, charactersDictionary } }) as unknown as PaddleEngine;
        await engine.initialize();
        plog('ocr', 'PaddleOCR loaded', { model: size, ms: Date.now() - started });
        return engine;
      })();
      // A failed load must not be cached, so the next request can retry.
      this.engine.catch(() => { this.engine = null; });
    }
    return this.engine;
  }

  /**
   * Returns results for the frames Paddle read and the frames it failed on.
   * Throws when the engine cannot load at all (package or model missing).
   */
  static async extractTextFromFrames(frames: VideoFrame[]): Promise<{ results: ApifyOcrFrameResult[]; failed: VideoFrame[] }> {
    if (frames.length === 0) return { results: [], failed: [] };
    const engine = await this.getEngine();
    const concurrency = Number(process.env.PADDLE_OCR_CONCURRENCY) > 0 ? Number(process.env.PADDLE_OCR_CONCURRENCY) : DEFAULT_CONCURRENCY;
    plog('ocr', 'PaddleOCR started', { model: modelSize(), frames: frames.length, concurrency });

    const results: ApifyOcrFrameResult[] = [];
    const failed: VideoFrame[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, frames.length) }, async () => {
      while (next < frames.length) {
        const frame = frames[next++];
        try {
          const image = toArrayBuffer(fs.readFileSync(frame.colorFilePath || frame.filePath));
          results.push(paddleFrameResult(frame, await engine.recognize(image, { noCache: true })));
        } catch (error) {
          plog('ocr', `PaddleOCR frame ${frame.frameIndex} failed`, { error: errorMessage(error) }, 'warn');
          failed.push(frame);
        }
      }
    }));

    results.sort((a, b) => a.frameIndex - b.frameIndex);
    failed.sort((a, b) => a.frameIndex - b.frameIndex);
    plog('ocr', 'PaddleOCR done', {
      frames: frames.length,
      read: results.length,
      failed: failed.length,
      linesRead: results.reduce((sum, result) => sum + (result.lines?.length || 0), 0),
    });
    return { results, failed };
  }
}
