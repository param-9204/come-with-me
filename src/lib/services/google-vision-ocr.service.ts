import fs from 'fs';
import type { GptVisionFrameResult, VideoFrame } from '../types/social';
import { plog, recordPipelineOperation } from './pipeline-log';

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const IMAGES_PER_REQUEST = 8;
const REQUEST_TIMEOUT_MS = 16_000;

/** Thrown when the key is missing, the API is disabled, or the key is not allowed to call it. */
export class GoogleVisionUnavailableError extends Error {}

interface AnnotateResponse {
  fullTextAnnotation?: {
    text?: string;
    pages?: Array<{ confidence?: number; blocks?: Array<{ confidence?: number }> }>;
  };
  textAnnotations?: Array<{ description?: string }>;
  error?: { code?: number; message?: string };
}

/** Mean block confidence reported by Vision, or null when the API did not report one. */
function reportedConfidence(response: AnnotateResponse): number | null {
  const values = (response.fullTextAnnotation?.pages || [])
    .flatMap((page) => (page.blocks || []).map((block) => block.confidence))
    .filter((value): value is number => typeof value === 'number' && value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * Google Cloud Vision TEXT_DETECTION. Used only as a paid fallback for frames
 * that local OCR could not read confidently (stylised overlays, shop signs).
 */
export class GoogleVisionOcrService {
  /** After a 401/403 (API disabled or key restricted), skip Vision for a while instead of failing every post. */
  private static unavailableUntil = 0;
  private static readonly UNAVAILABLE_BACKOFF_MS = 10 * 60_000;

  static apiKey(): string | null {
    const key = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
    return key && !key.startsWith('your-google-') ? key.trim() : null;
  }

  static isConfigured(): boolean {
    return !!this.apiKey() && Date.now() >= this.unavailableUntil;
  }

  static markUnavailable(): void {
    this.unavailableUntil = Date.now() + this.UNAVAILABLE_BACKOFF_MS;
  }

  static parseResponse(frame: VideoFrame, response: AnnotateResponse): GptVisionFrameResult {
    const fullText = response.fullTextAnnotation?.text || response.textAnnotations?.[0]?.description || '';
    const texts = [...new Set(fullText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 2))];
    const confidence = reportedConfidence(response);
    return {
      frameIndex: frame.frameIndex,
      timestamp: frame.timestamp,
      texts,
      brands: [],
      locations: [],
      prices: [],
      cta: [],
      description: '',
      // Vision often omits confidence for TEXT_DETECTION; 0 means "not reported".
      confidence: confidence ?? 0,
      method: 'google-vision',
    };
  }

  static async extractTextFromFrames(frames: VideoFrame[], languageHints: string[] = []): Promise<GptVisionFrameResult[]> {
    const key = this.apiKey();
    if (!key) throw new GoogleVisionUnavailableError('No Google API key configured for Cloud Vision.');
    const results: GptVisionFrameResult[] = [];

    for (let offset = 0; offset < frames.length; offset += IMAGES_PER_REQUEST) {
      const batch = frames.slice(offset, offset + IMAGES_PER_REQUEST);
      const operationStarted = new Date();
      const requests = batch.map((frame) => ({
        image: { content: fs.readFileSync(frame.colorFilePath || frame.filePath).toString('base64') },
        features: [{ type: 'TEXT_DETECTION' }],
        ...(languageHints.length ? { imageContext: { languageHints } } : {}),
      }));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const body = await response.json().catch(() => ({})) as { responses?: AnnotateResponse[]; error?: { message?: string; status?: string } };
      if (response.status === 403 || response.status === 401 || body.error?.status === 'PERMISSION_DENIED') {
        this.markUnavailable();
        recordPipelineOperation({
          stage: 'vision', operation: 'cloud_vision_ocr_batch', provider: 'google', model: 'cloud-vision-text-detection',
          status: 'failed', startedAt: operationStarted, finishedAt: new Date(), inputUnits: batch.length,
          error: new Error(`Cloud Vision rejected the key (HTTP ${response.status}): ${body.error?.message || 'enable the Cloud Vision API for this key'}`),
          retryable: false, requestSummary: { frames: batch.length, feature: 'TEXT_DETECTION' },
        });
        throw new GoogleVisionUnavailableError(
          `Cloud Vision rejected the key (HTTP ${response.status}): ${body.error?.message || 'enable the Cloud Vision API for this key'}`
        );
      }
      if (!response.ok) {
        recordPipelineOperation({
          stage: 'vision', operation: 'cloud_vision_ocr_batch', provider: 'google', model: 'cloud-vision-text-detection',
          status: 'failed', startedAt: operationStarted, finishedAt: new Date(), inputUnits: batch.length,
          error: new Error(`Cloud Vision HTTP ${response.status}: ${body.error?.message || 'unknown error'}`), retryable: response.status >= 500 || response.status === 429,
          requestSummary: { frames: batch.length, feature: 'TEXT_DETECTION' },
        });
        throw new Error(`Cloud Vision HTTP ${response.status}: ${body.error?.message || 'unknown error'}`);
      }

      const frameErrors = (body.responses || []).filter((item) => item?.error).length;
      batch.forEach((frame, index) => {
        const item = body.responses?.[index] || {};
        if (item.error) {
          plog('vision', `Cloud Vision frame ${frame.frameIndex} error`, { error: item.error.message }, 'warn');
        }
        results.push(this.parseResponse(frame, item));
      });
      recordPipelineOperation({
        stage: 'vision',
        operation: 'cloud_vision_ocr_batch',
        provider: 'google',
        model: 'cloud-vision-text-detection',
        status: frameErrors ? 'partial' : 'success',
        startedAt: operationStarted,
        finishedAt: new Date(),
        inputUnits: batch.length,
        // Cloud Vision is unit-priced. Keep this configurable because account
        // agreements and regional pricing may differ from the public default.
        estimatedCostUsd: batch.length * (Number(process.env.GOOGLE_VISION_TEXT_COST_PER_IMAGE_USD) || 0.0015),
        costBasis: { pricing: 'per_image_estimate', unitCostUsd: Number(process.env.GOOGLE_VISION_TEXT_COST_PER_IMAGE_USD) || 0.0015 },
        requestSummary: { frames: batch.length, feature: 'TEXT_DETECTION', languageHints },
        resultSummary: { frameErrors, framesWithText: batch.filter((_, index) => this.parseResponse(batch[index], body.responses?.[index] || {}).texts.length > 0).length },
      });
    }

    plog('vision', 'Cloud Vision done', { frames: results.length, withText: results.filter((r) => r.texts.length).length });
    return results;
  }
}
