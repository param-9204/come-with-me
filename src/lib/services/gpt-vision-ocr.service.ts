/**
 * GptVisionOcrService
 *
 * Uses GPT-4o Vision to analyze video frames.
 * Unlike Tesseract (Apify OCR), GPT-4o Vision understands:
 *   - Stylized social-media fonts & text overlays
 *   - Logos and brand identities
 *   - Context-aware text (price tags, addresses, CTAs)
 *   - Emojis and decorative elements
 *
 * This is the "AI Vision" path shown in the demo comparison.
 */

import OpenAI from 'openai';
import fs from 'fs';
import type { VideoFrame, GptVisionFrameResult } from '../types/social';

const MAX_FRAMES_FOR_VISION = 30;

const FRAME_SYSTEM_PROMPT = `You are a video frame analyzer for an influencer marketing platform called "Come With Me".

Analyze the provided video frame and extract ALL visible information.

Focus on:
- All readable text (overlays, subtitles, captions, signs, labels, menus)
- Brand names and logos
- Restaurant/business names
- Prices, offers, discounts
- Location names, addresses, street signs
- Call-to-action text (Visit us, Book now, etc.)
- Product names and features
- People's names shown on screen
- Website URLs, phone numbers shown

Return a JSON object with these exact fields:
{
  "texts": ["all", "visible", "text", "strings"],
  "brands": ["brand names visible"],
  "locations": ["location names, addresses"],
  "prices": ["$XX price strings"],
  "cta": ["call to action text"],
  "website_urls": ["any URLs shown"],
  "phone_numbers": ["any phone numbers shown"],
  "description": "one sentence describing what is shown in this frame",
  "has_text_overlay": true,
  "confidence": 0.95
}

Rules:
- Include EVERY visible text string, even partial ones
- Do NOT invent text that is not visible
- If a field has no matches, return an empty array []
- confidence is your overall certainty (0.0 to 1.0)`;

export class GptVisionOcrService {
  private static getClient() {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  /**
   * Analyze a single video frame with GPT-4o Vision.
   * Sends the frame as a base64-encoded JPEG.
   */
  static async analyzeFrame(frame: VideoFrame, contextHint?: string): Promise<GptVisionFrameResult> {
    const openai = this.getClient();

    let base64Image: string;
    try {
      const buffer = fs.readFileSync(frame.filePath);
      base64Image = buffer.toString('base64');
    } catch (err) {
      console.error(`[GPT Vision] Cannot read frame file: ${frame.filePath}`);
      return this.emptyResult(frame);
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: FRAME_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                  detail: 'high',   // High detail for text extraction
                },
              },
              {
                type: 'text',
                text: `Analyze this video frame (timestamp: ${frame.timestamp.toFixed(1)}s). Extract ALL visible text, brands, prices, and locations. Return as JSON.`,
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 600,
      });

      const raw = response.choices[0].message.content || '{}';
      const parsed = JSON.parse(raw);

      return {
        frameIndex: frame.frameIndex,
        timestamp: frame.timestamp,
        texts: this.cleanArray(parsed.texts),
        brands: this.cleanArray(parsed.brands),
        locations: this.cleanArray(parsed.locations),
        prices: this.cleanArray(parsed.prices),
        cta: this.cleanArray(parsed.cta),
        description: parsed.description || '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
        method: 'gpt-4o-vision',
      };
    } catch (err) {
      console.error(`[GPT Vision] Frame ${frame.frameIndex} analysis failed:`, err);
      return this.emptyResult(frame);
    }
  }

  static async extractTextFromFrames(
    frames: VideoFrame[],
    contextHint?: string
  ): Promise<GptVisionFrameResult[]> {
    if (!frames || frames.length === 0) return [];

    const framesToProcess = frames.slice(0, MAX_FRAMES_FOR_VISION);
    console.log(`[GPT Vision] Analyzing ${framesToProcess.length} frames with GPT-4o Vision...`);

    const results: GptVisionFrameResult[] = [];

    for (const frame of framesToProcess) {
      const result = await this.analyzeFrame(frame, contextHint);
      results.push(result);
      console.log(
        `[GPT Vision] Frame ${frame.frameIndex} @ ${frame.timestamp.toFixed(1)}s → ` +
        `${result.texts.length} texts, ${result.brands.length} brands, conf=${result.confidence.toFixed(2)}`
      );
    }

    return results;
  }

  /**
   * Aggregate all frame results into deduplicated lists.
   * Used to feed the main AI analysis with consolidated OCR output.
   */
  static aggregateResults(results: GptVisionFrameResult[]) {
    const dedup = <T>(arr: T[]): T[] => [...new Set(arr)];

    const allTexts = dedup(results.flatMap(r => r.texts).filter(Boolean));
    const allBrands = dedup(results.flatMap(r => r.brands).filter(Boolean));
    const allLocations = dedup(results.flatMap(r => r.locations).filter(Boolean));
    const allPrices = dedup(results.flatMap(r => r.prices).filter(Boolean));
    const allCtas = dedup(results.flatMap(r => r.cta).filter(Boolean));

    return { allTexts, allBrands, allLocations, allPrices, allCtas };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private static cleanArray(val: unknown): string[] {
    if (!Array.isArray(val)) return [];
    return val
      .map((v: unknown) => (typeof v === 'string' ? v.trim() : String(v).trim()))
      .filter(v => v.length > 0);
  }

  private static emptyResult(frame: VideoFrame): GptVisionFrameResult {
    return {
      frameIndex: frame.frameIndex,
      timestamp: frame.timestamp,
      texts: [],
      brands: [],
      locations: [],
      prices: [],
      cta: [],
      description: 'Analysis unavailable',
      confidence: 0,
      method: 'gpt-4o-vision',
    };
  }
}
