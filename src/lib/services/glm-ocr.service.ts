import fs from 'fs';
import type { GptVisionFrameResult, VideoFrame } from '../types/social';
import { errorMessage, logCall, plog } from './pipeline-log';

const LAYOUT_ENDPOINT = 'https://api.z.ai/api/paas/v4/layout_parsing';
const CHAT_ENDPOINT = 'https://api.z.ai/api/paas/v4/chat/completions';
/** GLM-OCR uses the layout_parsing endpoint; any other model (e.g. glm-4.6v-flash) uses chat completions. */
const LAYOUT_MODEL = 'glm-ocr';
const DEFAULT_MODEL = 'glm-4.6v-flash';
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 3_000;
/**
 * The free glm-4.6v-flash often answers "overloaded": measured on a 12-frame
 * reel, 12 of 26 calls were refused and the frames took 326 s one by one.
 * Frames not read within this budget go to the next OCR step instead of
 * holding the request past the route's time limit.
 */
const DEFAULT_TIME_BUDGET_SEC = 90;
const MAX_OUTPUT_TOKENS = 1_500;
/** Z.ai business code for "Insufficient balance or no resource package". */
const NO_BALANCE_CODE = '1113';

const VISION_PROMPT = `You are an OCR engine for a social-media image or video frame. Transcribe every visible text string exactly as written, one string per line of text: overlays, captions, location stickers, shop signs, menus, street signs, handles. Small text matters as much as large titles.
Location markers come in many styles: 📍 or 📌 emoji, map-pin or location icons, Instagram/TikTok location stickers, and labels such as "Location:", "Address:" or "Where:". Write each marked item as "📍 " followed by everything written on it — venue name, address, neighbourhood, city — joining the lines of one sticker with " · " (e.g. "📍 Buvette · 42 Grove St · West Village").
Keep original spelling and language. Dense lists (20+ entries with addresses) are normal; never shorten or summarise. Do not describe the image and do not infer text that is not visible.
Return only JSON: {"texts":[]}`;

/** Thrown when the key is missing or rejected, or the account has no balance. */
export class GlmOcrUnavailableError extends Error {}

interface LayoutElement {
  label?: string;
  content?: string;
}

export interface LayoutParsingResponse {
  md_results?: string;
  layout_details?: LayoutElement[][];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  code?: string | number;
  message?: string;
  error?: { code?: string | number; message?: string };
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  code?: string | number;
  message?: string;
  error?: { code?: string | number; message?: string };
}

type ZaiBody = LayoutParsingResponse & ChatResponse;

/** Plain text lines from markdown/HTML content (tables become " · "-joined rows). */
function plainLines(content: string): string[] {
  return content
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' · ')
    .replace(/<br\s*\/?>|<\/(?:tr|p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/^\s*[-*]\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .trim())
    .filter((line) => line.length >= 2 && !/^[|:\-\s]+$/.test(line));
}

/** Text lines of one GLM-OCR (layout_parsing) answer, in reading order, without duplicates. */
export function glmTextLines(response: LayoutParsingResponse): string[] {
  const elements = (response.layout_details || []).flat().filter((element) => element?.label !== 'image');
  const lines = elements.length
    ? elements.flatMap((element) => plainLines(element.content || ''))
    : plainLines(response.md_results || '');
  return [...new Set(lines)];
}

/**
 * Text lines of a chat-model answer. The model sometimes wraps the JSON in
 * prose ("The text in the image is…"), so the first {...} block is used.
 * Returns null when no JSON can be read (the frame then counts as failed).
 */
export function parseVisionAnswer(content: string): string[] | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { texts?: unknown };
    if (!Array.isArray(parsed.texts)) return null;
    const texts = parsed.texts
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length >= 2);
    return [...new Set(texts)];
  } catch {
    return null;
  }
}

function errorCode(body: ZaiBody): string {
  return String(body.error?.code ?? body.code ?? '');
}

function errorText(body: ZaiBody): string {
  return body.error?.message || body.message || '';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const positive = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Number(value) : fallback);

/**
 * Z.ai OCR. GLM_OCR_MODEL picks the model:
 * - glm-4.6v-flash (default): free vision model, chat completions endpoint;
 * - glm-ocr: paid OCR model, layout_parsing endpoint (needs account balance).
 * Does not use OpenAI tokens. Frames it cannot read are returned as `failed`
 * so the next OCR step can take them.
 */
export class GlmOcrService {
  /** After an auth or balance error, skip Z.ai for a while instead of failing every frame. */
  private static unavailableUntil = 0;
  private static readonly UNAVAILABLE_BACKOFF_MS = 10 * 60_000;

  static apiKey(): string | null {
    const key = process.env.ZAI_API_KEY?.trim().replace(/^"|"$/g, '');
    return key && !key.startsWith('your-') ? key : null;
  }

  static model(): string {
    return process.env.GLM_OCR_MODEL?.trim() || DEFAULT_MODEL;
  }

  static isConfigured(): boolean {
    return !!this.apiKey() && Date.now() >= this.unavailableUntil;
  }

  static markUnavailable(): void {
    this.unavailableUntil = Date.now() + this.UNAVAILABLE_BACKOFF_MS;
  }

  private static async post(key: string, model: string, dataUri: string, deadline: number): Promise<{ status: number; body: ZaiBody }> {
    const layout = model === LAYOUT_MODEL;
    const payload = layout
      ? { model, file: dataUri }
      : {
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUri } },
              { type: 'text', text: VISION_PROMPT },
            ],
          }],
          thinking: { type: 'disabled' },
          max_tokens: MAX_OUTPUT_TOKENS,
        };
    const response = await fetch(layout ? LAYOUT_ENDPOINT : CHAT_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Never wait past the step time budget: an in-flight call used to overrun it by up to 60 s.
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))),
    });
    const text = await response.text();
    let body: ZaiBody = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 300) };
    }
    return { status: response.status, body };
  }

  static async readFrame(frame: VideoFrame, key: string, deadline = Number.POSITIVE_INFINITY): Promise<{ texts: string[]; promptTokens: number; completionTokens: number }> {
    const model = this.model();
    // Verified live on 2026-09-23: glm-4.6v-flash accepts a data URI.
    const dataUri = `data:image/jpeg;base64,${fs.readFileSync(frame.colorFilePath || frame.filePath).toString('base64')}`;
    const retries = positive(process.env.GLM_OCR_RETRIES, DEFAULT_RETRIES);

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let status = 0;
      let body: ZaiBody = {};
      try {
        ({ status, body } = await this.post(key, model, dataUri, deadline));
      } catch (error) {
        logCall({ stage: 'vision', operation: 'vision_ocr', provider: 'zai', model, status: 'error', attempt: attempt + 1, images: 1, latencyMs: Date.now() - started, error: errorMessage(error) });
        throw error;
      }
      const code = errorCode(body);
      logCall({
        stage: 'vision',
        operation: 'vision_ocr',
        provider: 'zai',
        model,
        status: status === 200 ? 'success' : 'error',
        attempt: attempt + 1,
        httpStatus: status,
        images: 1,
        latencyMs: Date.now() - started,
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
        finishReason: body.choices?.[0]?.finish_reason ?? null,
        error: status === 200 ? null : `${code ? `code ${code}: ` : ''}${errorText(body)}`,
      });
      if (status === 401 || status === 403 || code === NO_BALANCE_CODE) {
        throw new GlmOcrUnavailableError(`${model} unavailable (HTTP ${status}${code ? `, code ${code}` : ''}): ${errorText(body)}`);
      }
      if (status === 200) {
        const usage = { promptTokens: body.usage?.prompt_tokens || 0, completionTokens: body.usage?.completion_tokens || 0 };
        if (model === LAYOUT_MODEL) return { texts: glmTextLines(body), ...usage };
        const choice = body.choices?.[0];
        const texts = parseVisionAnswer(choice?.message?.content || '');
        if (texts === null) throw new Error(`${model} answer was not JSON${choice?.finish_reason === 'length' ? ' (cut off)' : ''}`);
        return { texts, ...usage };
      }
      // Overloaded (429 / code 1305) or server error: retry with backoff while time allows.
      const wait = RETRY_BASE_MS * (attempt + 1);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= retries || Date.now() + wait > deadline) {
        throw new Error(`${model} HTTP ${status}${code ? ` code ${code}` : ''}: ${errorText(body)}`);
      }
      await sleep(wait);
    }
  }

  static async extractTextFromFrames(frames: VideoFrame[]): Promise<{ results: GptVisionFrameResult[]; failed: VideoFrame[] }> {
    const key = this.apiKey();
    if (!key) throw new GlmOcrUnavailableError('ZAI_API_KEY is not set.');
    const model = this.model();
    const concurrency = positive(process.env.GLM_OCR_CONCURRENCY, DEFAULT_CONCURRENCY);
    const budgetSec = positive(process.env.GLM_OCR_TIME_BUDGET_SEC, DEFAULT_TIME_BUDGET_SEC);
    const deadline = Date.now() + budgetSec * 1000;
    plog('vision', 'Z.ai OCR started', { model, frames: frames.length, concurrency, timeBudgetSec: budgetSec });

    const results: GptVisionFrameResult[] = [];
    const failed: VideoFrame[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let unavailable: string | null = null;
    let outOfTime = 0;
    let next = 0;

    await Promise.all(Array.from({ length: Math.min(concurrency, frames.length) }, async () => {
      while (next < frames.length) {
        const frame = frames[next++];
        if (unavailable || Date.now() >= deadline) {
          if (!unavailable) outOfTime++;
          failed.push(frame);
          continue;
        }
        try {
          const read = await this.readFrame(frame, key, deadline);
          promptTokens += read.promptTokens;
          completionTokens += read.completionTokens;
          results.push({
            frameIndex: frame.frameIndex,
            timestamp: frame.timestamp,
            texts: read.texts,
            brands: [],
            locations: [],
            prices: [],
            cta: [],
            description: '',
            confidence: 0,
            method: 'glm-ocr',
          });
        } catch (error) {
          if (error instanceof GlmOcrUnavailableError) {
            unavailable = error.message;
            this.markUnavailable();
          } else {
            plog('vision', `Z.ai OCR frame ${frame.frameIndex} failed`, { error: errorMessage(error) }, 'warn');
          }
          failed.push(frame);
        }
      }
    }));

    if (unavailable) plog('vision', 'Z.ai OCR unavailable; remaining frames go to the next OCR step', { error: unavailable }, 'warn');
    if (outOfTime) plog('vision', `Z.ai OCR time budget (${budgetSec}s) used up; ${outOfTime} frame(s) go to the next OCR step`, undefined, 'warn');
    results.sort((a, b) => a.frameIndex - b.frameIndex);
    failed.sort((a, b) => a.frameIndex - b.frameIndex);
    plog('vision', 'Z.ai OCR done', {
      model,
      frames: frames.length,
      read: results.length,
      withText: results.filter((result) => result.texts.length).length,
      failed: failed.length,
      promptTokens,
      completionTokens,
    });
    return { results, failed };
  }
}
