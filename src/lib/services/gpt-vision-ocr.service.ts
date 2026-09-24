import fs from 'fs';
import { executeAICall, gptVisionModel } from './ai-client';
import { plog } from './pipeline-log';
import { chatUsage } from './usage-cost';
import type { GptVisionFrameResult, VideoFrame } from '../types/social';

const FRAME_SYSTEM_PROMPT = `Read every visible text string in this TikTok video frame. Focus on venue names, addresses, neighborhood/city text, list numbering, handles, and labels. Do not infer text that is not visible. Return JSON with: {"texts":string[],"brands":string[],"locations":string[],"prices":string[],"cta":string[],"description":string,"confidence":number}.`;

const BATCH_SYSTEM_PROMPT = `You are an OCR engine for social-video frames. For each numbered image, transcribe every visible text string exactly as written, one string per line of text: overlays, captions, location stickers, shop signs, menus, street signs, handles. Small text matters as much as large titles.
Location markers come in many styles: 📍 or 📌 emoji, map-pin or location icons, Instagram/TikTok location stickers, and labels such as "Location:", "Address:" or "Where:". Write each marked item as "📍 " followed by everything written on it — venue name, address, neighbourhood, city — joining the lines of one sticker with " · " (e.g. "📍 Buvette · 42 Grove St · West Village"). These usually identify the place shown. Keep original spelling and language. Do not describe the image and do not infer text that is not visible.
Return JSON: {"images":[{"index":0,"texts":[]}]}. Include every image index and every line of text — dense lists (20+ entries with addresses) are normal; never shorten or summarise.`;

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * GPT vision OCR. The media pipeline uses the batched method only as a
 * fallback for frames local OCR could not read (when Cloud Vision is not
 * available); the legacy /ocr-frame route still uses analyzeFrame.
 */
export class GptVisionOcrService {
  static async analyzeFrame(frame: VideoFrame): Promise<GptVisionFrameResult> {
    try {
      const image = fs.readFileSync(frame.colorFilePath || frame.filePath).toString('base64');
      return await executeAICall('vision', async ({ client, model, reportUsage }) => {
        const response = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: FRAME_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' },
                },
                { type: 'text', text: `Frame timestamp: ${frame.timestamp.toFixed(1)} seconds.` },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 700,
        });
        reportUsage?.(chatUsage(response));
        const result = JSON.parse(response.choices[0]?.message?.content || '{}');
        return {
          frameIndex: frame.frameIndex,
          timestamp: frame.timestamp,
          texts: cleanStrings(result.texts),
          brands: cleanStrings(result.brands),
          locations: cleanStrings(result.locations),
          prices: cleanStrings(result.prices),
          cta: cleanStrings(result.cta),
          description: typeof result.description === 'string' ? result.description : '',
          confidence: typeof result.confidence === 'number' ? result.confidence : 0,
          method: 'gpt-4o-vision',
        };
      }, { operation: 'vision_ocr', images: 1 });
    } catch (error: any) {
      plog('vision', `GPT vision frame ${frame.frameIndex} failed`, { error: error.message || String(error) }, 'warn');
      return this.emptyResult(frame);
    }
  }

  static async extractTextFromFrames(frames: VideoFrame[]): Promise<GptVisionFrameResult[]> {
    if (!gptVisionModel()) return [];
    const results: GptVisionFrameResult[] = [];
    for (const frame of frames) {
      results.push(await this.analyzeFrame(frame));
    }
    return results;
  }

  /** One request for up to 4 images. Returns null texts when the answer was cut off or unreadable. */
  private static async readBatch(batch: VideoFrame[], tokensPerImage: number): Promise<{ texts: string[][] | null; truncated: boolean }> {
    return executeAICall('vision', async ({ client, model, reportUsage }) => {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: BATCH_SYSTEM_PROMPT },
          {
            role: 'user',
            content: batch.flatMap((frame, index) => [
              { type: 'text' as const, text: `Image ${index} (t=${frame.timestamp.toFixed(1)}s):` },
              {
                type: 'image_url' as const,
                image_url: {
                  url: `data:image/jpeg;base64,${fs.readFileSync(frame.colorFilePath || frame.filePath).toString('base64')}`,
                  detail: 'high' as const,
                },
              },
            ]),
          },
        ],
        response_format: { type: 'json_object' },
        // Only generated tokens are billed; dense list slides need room.
        max_completion_tokens: tokensPerImage * batch.length,
      });
      const choice = response.choices[0];
      reportUsage?.(chatUsage(response));
      const truncated = choice?.finish_reason === 'length';
      plog('vision', 'GPT vision batch', {
        model,
        frames: batch.length,
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        ...(truncated ? { truncated: true } : {}),
      }, truncated ? 'warn' : 'info');
      let parsed: any;
      try {
        parsed = JSON.parse(choice?.message?.content || '{}');
      } catch {
        return { texts: null, truncated };
      }
      const byIndex = new Map<number, any>(
        (Array.isArray(parsed.images) ? parsed.images : []).map((item: any) => [Number(item?.index), item])
      );
      return { texts: batch.map((_, index) => cleanStrings(byIndex.get(index)?.texts)), truncated };
    }, { operation: 'vision_ocr', images: batch.length });
  }

  /**
   * Fallback OCR for several frames per request (up to 4 images per call), so
   * the system prompt is paid once per batch. A batch whose answer is cut off
   * is re-read one image at a time with a larger budget rather than lost.
   */
  static async extractTextFromFramesBatched(frames: VideoFrame[], perRequest = 4): Promise<GptVisionFrameResult[]> {
    if (!gptVisionModel()) {
      plog('vision', 'GPT vision skipped (USE_GPT_VISION_MODEL not set)', { frames: frames.length });
      return [];
    }
    const results: GptVisionFrameResult[] = [];
    const toResult = (frame: VideoFrame, texts: string[]) => ({ ...this.emptyResult(frame), texts });
    for (let offset = 0; offset < frames.length; offset += perRequest) {
      const batch = frames.slice(offset, offset + perRequest);
      try {
        const first = await this.readBatch(batch, 1_500);
        if (first.texts && !first.truncated) {
          batch.forEach((frame, index) => results.push(toResult(frame, first.texts![index])));
          continue;
        }
        plog('vision', 'GPT vision answer was cut off; re-reading images one at a time', { frames: batch.length }, 'warn');
        for (const frame of batch) {
          const single = await this.readBatch([frame], 4_000);
          if (!single.texts || single.truncated) {
            plog('vision', `GPT vision could not read all text on frame ${frame.frameIndex}`, { truncated: single.truncated }, 'error');
          }
          results.push(toResult(frame, single.texts?.[0] || []));
        }
      } catch (error: any) {
        plog('vision', 'GPT vision batch failed', { frames: batch.length, error: error.message || String(error) }, 'warn');
        results.push(...batch.map((frame) => this.emptyResult(frame)));
      }
    }
    return results;
  }

  static aggregateResults(results: GptVisionFrameResult[]) {
    const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
    return {
      allTexts: unique(results.flatMap((result) => result.texts)),
      allBrands: unique(results.flatMap((result) => result.brands)),
      allLocations: unique(results.flatMap((result) => result.locations)),
      allPrices: unique(results.flatMap((result) => result.prices)),
      allCtas: unique(results.flatMap((result) => result.cta)),
    };
  }

  private static emptyResult(frame: VideoFrame): GptVisionFrameResult {
    return {
      frameIndex: frame.frameIndex,
      timestamp: frame.timestamp,
      texts: [], brands: [], locations: [], prices: [], cta: [],
      description: '', confidence: 0, method: 'gpt-4o-vision',
    };
  }
}
