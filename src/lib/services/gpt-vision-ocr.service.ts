import fs from 'fs';
import { executeAICall } from './ai-client';
import type { GptVisionFrameResult, VideoFrame } from '../types/social';

const FRAME_SYSTEM_PROMPT = `Read every visible text string in this TikTok video frame. Focus on venue names, addresses, neighborhood/city text, list numbering, handles, and labels. Do not infer text that is not visible. Return JSON with: {"texts":string[],"brands":string[],"locations":string[],"prices":string[],"cta":string[],"description":string,"confidence":number}.`;

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Vision OCR is invoked only for TikTok frames by the pipeline callers. */
export class GptVisionOcrService {
  static async analyzeFrame(frame: VideoFrame): Promise<GptVisionFrameResult> {
    try {
      const image = fs.readFileSync(frame.filePath).toString('base64');
      return await executeAICall('vision', async ({ client, model }) => {
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
      });
    } catch (error: any) {
      console.warn(`[GPT Vision] Frame ${frame.frameIndex} failed:`, error.message || error);
      return this.emptyResult(frame);
    }
  }

  static async extractTextFromFrames(frames: VideoFrame[]): Promise<GptVisionFrameResult[]> {
    const results: GptVisionFrameResult[] = [];
    for (const frame of frames) {
      results.push(await this.analyzeFrame(frame));
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
