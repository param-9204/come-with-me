import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabaseAdmin: {} }));

import { MediaEvidenceService, ocrOrder, ocrStepAvailable } from '../media-evidence.service';
import { GlmOcrService, glmTextLines, parseVisionAnswer } from '../glm-ocr.service';
import { GoogleVisionOcrService } from '../google-vision-ocr.service';
import { GptVisionOcrService } from '../gpt-vision-ocr.service';
import { ApifyOcrService } from '../apify-ocr.service';
import { PaddleOcrService, paddleFrameResult } from '../paddle-ocr.service';
import { getAIClientConfigs } from '../ai-client';
import type { GptVisionFrameResult, VideoFrame } from '../../types/social';
import { makeContent, ocrFrame } from './fixtures';

const ENV_KEYS = ['OCR_ORDER', 'ZAI_API_KEY', 'USE_GPT_VISION_MODEL', 'OPENAI_API_KEY', 'GOOGLE_VISION_API_KEY', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_PLACES_API_KEY'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Chain tests default to "Paddle not installed" so they never download models.
  vi.spyOn(PaddleOcrService, 'extractTextFromFrames').mockRejectedValue(new Error('paddle not loaded'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const frame = (i: number): VideoFrame => ({ frameIndex: i, timestamp: i, filePath: `f${i}.jpg`, colorFilePath: `f${i}.jpg`, hash: String(i) });
const read = (f: VideoFrame, texts: string[], method: GptVisionFrameResult['method']): GptVisionFrameResult => ({
  frameIndex: f.frameIndex, timestamp: f.timestamp, texts, brands: [], locations: [], prices: [], cta: [], description: '', confidence: 0, method,
});

describe('OCR_ORDER', () => {
  it('defaults to Z.ai, PaddleOCR, Cloud Vision, GPT vision, then Tesseract as last resort', () => {
    expect(ocrOrder()).toEqual(['glm', 'paddle', 'google', 'gpt', 'tesseract']);
  });

  it('follows the order and names in .env, dropping unknown steps', () => {
    process.env.OCR_ORDER = 'tesseract, cloud-vision > glm-ocr, magic';
    expect(ocrOrder()).toEqual(['tesseract', 'google', 'glm']);
  });

  it('runs each step only when it is configured', () => {
    expect(ocrStepAvailable('tesseract')).toBe(true);
    expect(ocrStepAvailable('glm')).toBe(false);
    expect(ocrStepAvailable('google')).toBe(false);
    expect(ocrStepAvailable('gpt')).toBe(false);
    process.env.ZAI_API_KEY = 'zai-test';
    process.env.GOOGLE_VISION_API_KEY = 'g-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(ocrStepAvailable('glm')).toBe(true);
    expect(ocrStepAvailable('google')).toBe(true);
    // An OpenAI key alone does not enable GPT vision.
    expect(ocrStepAvailable('gpt')).toBe(false);
    process.env.USE_GPT_VISION_MODEL = 'gpt-4o';
    expect(ocrStepAvailable('gpt')).toBe(true);
    expect(getAIClientConfigs('vision')[0].model).toBe('gpt-4o');
  });

  it('never calls GPT vision when USE_GPT_VISION_MODEL is unset', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => getAIClientConfigs('vision')).toThrow(/USE_GPT_VISION_MODEL/);
    expect(await GptVisionOcrService.extractTextFromFramesBatched([frame(0)])).toEqual([]);
    expect(await GptVisionOcrService.extractTextFromFrames([frame(0)])).toEqual([]);
  });
});

describe('OCR chain', () => {
  const content = makeContent({ caption: '5 restaurants in the West Village' });

  it('uses GLM-OCR first and skips Tesseract when GLM read every frame', async () => {
    process.env.ZAI_API_KEY = 'zai-test';
    const frames = [frame(0), frame(1)];
    vi.spyOn(GlmOcrService, 'extractTextFromFrames').mockResolvedValue({ results: frames.map((f) => read(f, ['📍 Buvette'], 'glm-ocr')), failed: [] });
    const tesseract = vi.spyOn(ApifyOcrService, 'extractTextFromFrames');
    const result = await MediaEvidenceService.runOcrChain(frames, content, []);
    expect(result.visionFrames.map((f) => f.method)).toEqual(['glm-ocr', 'glm-ocr']);
    expect(result.ocrFrames).toEqual([]);
    expect(tesseract).not.toHaveBeenCalled();
  });

  it('passes frames Z.ai could not read to Paddle, and Paddle failures to Cloud Vision, then GPT', async () => {
    process.env.ZAI_API_KEY = 'zai-test';
    process.env.GOOGLE_VISION_API_KEY = 'g-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.USE_GPT_VISION_MODEL = 'gpt-4o';
    const frames = [frame(0), frame(1), frame(2)];
    vi.spyOn(GlmOcrService, 'extractTextFromFrames').mockResolvedValue({ results: [read(frames[0], ['📍 Buvette'], 'glm-ocr')], failed: [frames[1], frames[2]] });
    // Paddle reads frame 1 and fails on frame 2.
    const paddle = vi.spyOn(PaddleOcrService, 'extractTextFromFrames').mockResolvedValue({
      results: [paddleFrameResult(frames[1], { lines: [[{ text: 'Morandi', confidence: 0.95 }]] })],
      failed: [frames[2]],
    });
    const google = vi.spyOn(GoogleVisionOcrService, 'extractTextFromFrames').mockRejectedValue(new Error('billing disabled'));
    const gpt = vi.spyOn(GptVisionOcrService, 'extractTextFromFramesBatched').mockImplementation(async (input) => input.map((f) => read(f, ['Bar Pisellino'], 'gpt-4o-vision')));
    const tesseract = vi.spyOn(ApifyOcrService, 'extractTextFromFrames');

    // Caption names no places and promises none → Paddle's frame is not escalated.
    const result = await MediaEvidenceService.runOcrChain(frames, makeContent({ caption: 'fall in nyc' }), []);
    expect(paddle.mock.calls[0][0].map((f) => f.frameIndex)).toEqual([1, 2]);
    expect(google.mock.calls[0][0].map((f) => f.frameIndex)).toEqual([2]);
    expect(gpt.mock.calls[0][0].map((f) => f.frameIndex)).toEqual([2]);
    expect(tesseract).not.toHaveBeenCalled();
    expect(result.visionFrames.map((f) => `${f.frameIndex}:${f.method}`)).toEqual(['0:glm-ocr', '2:gpt-4o-vision']);
    expect(result.ocrFrames.map((f) => f.frameIndex)).toEqual([1]);
  });

  it('still sends carousel slides and list-post frames Paddle read on to Cloud Vision', async () => {
    process.env.GOOGLE_VISION_API_KEY = 'g-test';
    const frames = [frame(0), frame(1)];
    vi.spyOn(PaddleOcrService, 'extractTextFromFrames').mockResolvedValue({
      results: frames.map((f) => paddleFrameResult(f, { lines: [[{ text: '7 STRER', confidence: 0.9 }]] })),
      failed: [],
    });
    const google = vi.spyOn(GoogleVisionOcrService, 'extractTextFromFrames').mockImplementation(async (input) => input.map((f) => read(f, ['7th Street Burger'], 'google-vision')));
    // Frame 1 is an image slide; frame 0 is not, and the caption promises nothing.
    const result = await MediaEvidenceService.runOcrChain(frames, makeContent({ caption: 'weekend', contentType: 'post', videoUrl: '' }), [1]);
    expect(google.mock.calls[0][0].map((f) => f.frameIndex)).toEqual([1]);
    expect(result.ocrFrames).toHaveLength(2);
    expect(result.visionFrames.map((f) => f.frameIndex)).toEqual([1]);
  });

  it('uses Tesseract as the last resort when Paddle cannot load and no vision step is available', async () => {
    const frames = [frame(0), frame(1)];
    const tesseract = vi.spyOn(ApifyOcrService, 'extractTextFromFrames').mockImplementation(async (input) => input.map((f) => ocrFrame(f.frameIndex, f.timestamp, [['Buve', 0.8]])));
    const result = await MediaEvidenceService.runOcrChain(frames, content, []);
    expect(tesseract.mock.calls[0][0].map((f) => f.frameIndex)).toEqual([0, 1]);
    expect(result.ocrFrames).toHaveLength(2);
    expect(result.visionFrames).toEqual([]);
  });

  it('keeps the old behaviour when GLM-OCR is not configured', async () => {
    process.env.GOOGLE_VISION_API_KEY = 'g-test';
    const frames = [frame(0)];
    const glm = vi.spyOn(GlmOcrService, 'extractTextFromFrames');
    vi.spyOn(ApifyOcrService, 'extractTextFromFrames').mockResolvedValue([ocrFrame(0, 0, [])]);
    const google = vi.spyOn(GoogleVisionOcrService, 'extractTextFromFrames').mockResolvedValue([read(frames[0], ['Buvette'], 'google-vision')]);
    const result = await MediaEvidenceService.runOcrChain(frames, content, []);
    expect(glm).not.toHaveBeenCalled();
    expect(google).toHaveBeenCalledTimes(1);
    expect(result.visionFrames[0].method).toBe('google-vision');
  });

  it('uses PaddleOCR for local OCR and skips Tesseract when Paddle read every frame', async () => {
    const frames = [frame(0), frame(1)];
    vi.spyOn(PaddleOcrService, 'extractTextFromFrames').mockResolvedValue({
      results: frames.map((f) => paddleFrameResult(f, { lines: [[{ text: 'Bar Pisellino', confidence: 0.95 }]] })),
      failed: [],
    });
    const tesseract = vi.spyOn(ApifyOcrService, 'extractTextFromFrames');
    const result = await MediaEvidenceService.runOcrChain(frames, makeContent({ caption: 'fall in nyc' }), []);
    expect(tesseract).not.toHaveBeenCalled();
    expect(result.ocrFrames.map((f) => f.lines?.map((l) => l.text))).toEqual([['Bar Pisellino'], ['Bar Pisellino']]);
  });

  it('gives Tesseract only the frames Paddle failed on', async () => {
    const frames = [frame(0), frame(1)];
    vi.spyOn(PaddleOcrService, 'extractTextFromFrames').mockResolvedValue({
      results: [paddleFrameResult(frames[0], { lines: [[{ text: 'Buvette', confidence: 0.9 }]] })],
      failed: [frames[1]],
    });
    const tesseract = vi.spyOn(ApifyOcrService, 'extractTextFromFrames').mockResolvedValue([ocrFrame(1, 1, [['Morandi', 0.8]])]);
    const result = await MediaEvidenceService.runOcrChain(frames, makeContent({ caption: 'fall in nyc' }), []);
    expect(tesseract.mock.calls[0][0].map((f) => f.frameIndex)).toEqual([1]);
    expect(result.ocrFrames.map((f) => f.frameIndex)).toEqual([0, 1]);
  });

  it('runs only the steps listed in OCR_ORDER', async () => {
    process.env.OCR_ORDER = 'tesseract';
    process.env.ZAI_API_KEY = 'zai-test';
    process.env.GOOGLE_VISION_API_KEY = 'g-test';
    const glm = vi.spyOn(GlmOcrService, 'extractTextFromFrames');
    const google = vi.spyOn(GoogleVisionOcrService, 'extractTextFromFrames');
    vi.spyOn(ApifyOcrService, 'extractTextFromFrames').mockResolvedValue([ocrFrame(0, 0, [])]);
    const result = await MediaEvidenceService.runOcrChain([frame(0)], content, []);
    expect(glm).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
    expect(result.ocrFrames).toHaveLength(1);
  });
});

describe('PaddleOCR result mapping', () => {
  it('keeps confident lines and builds word stats on the Tesseract scale', () => {
    const result = paddleFrameResult(frame(3), {
      lines: [
        [{ text: '5 cozy restaurants in the', confidence: 0.95 }],
        [{ text: 'Bar', confidence: 0.9 }, { text: 'Pisellino', confidence: 0.94 }],
        [{ text: 'VI', confidence: 0.3 }],
      ],
    });
    expect(result.lines).toEqual([
      { text: '5 cozy restaurants in the', confidence: 0.95 },
      { text: 'Bar Pisellino', confidence: 0.92 },
    ]);
    // 5 + 2 + 1 words; the 0.3 line counts as an unconfident word.
    expect(result.wordStats).toEqual({ total: 8, confident: 7, meanConfidence: 86 });
    expect(result.rawResult).toMatchObject({ engine: 'paddle' });
  });
});

describe('GLM-OCR', () => {
  it('turns layout output into plain text lines', () => {
    expect(glmTextLines({
      layout_details: [[
        { label: 'text', content: '## cozy restaurants in the west village' },
        { label: 'image', content: '' },
        { label: 'text', content: '📍 **Buvette**\n42 Grove St' },
        { label: 'table', content: '<table><tr><td>Morandi</td><td>211 Waverly Pl</td></tr></table>' },
        { label: 'text', content: '📍 **Buvette**' },
      ]],
    })).toEqual(['cozy restaurants in the west village', '📍 Buvette', '42 Grove St', 'Morandi · 211 Waverly Pl']);
    expect(glmTextLines({ md_results: '# Title\n- Via Carota\n\n' })).toEqual(['Title', 'Via Carota']);
  });

  it('reads the JSON inside a chat-model answer, even when wrapped in prose', () => {
    // Real glm-4.6v-flash answer shape (2026-09-23).
    expect(parseVisionAnswer('The text in the image is transcribed as follows:\n\n{"texts": ["aurants in the", "illage for fall", "Buvette"]}'))
      .toEqual(['aurants in the', 'illage for fall', 'Buvette']);
    expect(parseVisionAnswer('{"texts":["📍 Morandi","📍 Morandi"," "]}')).toEqual(['📍 Morandi']);
    expect(parseVisionAnswer('I cannot read this image.')).toBeNull();
  });

  it('defaults to the free glm-4.6v-flash model and honours GLM_OCR_MODEL', () => {
    expect(GlmOcrService.model()).toBe('glm-4.6v-flash');
    process.env.GLM_OCR_MODEL = 'glm-ocr';
    expect(GlmOcrService.model()).toBe('glm-ocr');
    delete process.env.GLM_OCR_MODEL;
  });

  it('sends frames not read within the time budget to the next step', async () => {
    process.env.ZAI_API_KEY = 'zai-test';
    process.env.GLM_OCR_CONCURRENCY = '1';
    process.env.GLM_OCR_TIME_BUDGET_SEC = '0.05';
    const frames = [frame(0), frame(1), frame(2)];
    vi.spyOn(GlmOcrService, 'readFrame').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { texts: ['📍 Buvette'], promptTokens: 1, completionTokens: 1 };
    });
    try {
      const result = await GlmOcrService.extractTextFromFrames(frames);
      expect(result.results.map((f) => f.frameIndex)).toEqual([0]);
      expect(result.failed.map((f) => f.frameIndex)).toEqual([1, 2]);
    } finally {
      delete process.env.GLM_OCR_CONCURRENCY;
      delete process.env.GLM_OCR_TIME_BUDGET_SEC;
    }
  });

  it('hands every frame to the next step when the account has no balance', async () => {
    process.env.ZAI_API_KEY = 'zai-test';
    const frames = [frame(0), frame(1)];
    vi.spyOn(GlmOcrService, 'readFrame').mockImplementation(async () => {
      const { GlmOcrUnavailableError } = await import('../glm-ocr.service');
      throw new GlmOcrUnavailableError('GLM-OCR unavailable (HTTP 429, code 1113): Insufficient balance');
    });
    const result = await GlmOcrService.extractTextFromFrames(frames);
    expect(result.results).toEqual([]);
    expect(result.failed.map((f) => f.frameIndex)).toEqual([0, 1]);
    expect(GlmOcrService.isConfigured()).toBe(false);
  });
});
