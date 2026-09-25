import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../supabase';
import { MediaService } from './media.service';
import { VideoFrameService } from './video-frame.service';
import { ApifyOcrService } from './apify-ocr.service';
import { GoogleVisionOcrService, GoogleVisionUnavailableError } from './google-vision-ocr.service';
import { GptVisionOcrService } from './gpt-vision-ocr.service';
import { WhisperService } from './whisper.service';
import { S3Service } from './s3.service';
import { errorMessage, plog } from './pipeline-log';
import { hasLocationMarker } from './place-evidence.service';
import type {
  ApifyOcrFrameResult, GptVisionFrameResult, PipelineStep, SocialContent,
  SubtitleTrack, TranscriptResult, VideoFrame,
} from '../types/social';

export interface AudioUploadRef {
  id: string;
  fileName: string;
  sizeBytes: number;
  publicUrl: string;
}

export interface MediaEvidenceResult {
  ocrFrames: ApifyOcrFrameResult[];
  visionFrames: GptVisionFrameResult[];
  transcript: TranscriptResult | null;
  /** Transcript text as stored on the post. */
  transcriptText: string;
  audioUpload: AudioUploadRef | null;
  steps: PipelineStep[];
  /** Non-fatal processing limitations safe to display to API clients. */
  warnings: string[];
}

type FallbackProvider = 'google' | 'openai' | 'off';

/**
 * Accuracy-first default: the complete extracted frame set is sent to both
 * Tesseract and batched GPT Vision. Use `selective` only for a deliberate
 * cost-saving fallback mode.
 */
export function useFullFrameGptVision(): boolean {
  const mode = (process.env.OCR_VISION_MODE || 'all-gpt').trim().toLowerCase();
  return !['selective', 'fallback'].includes(mode);
}

// No page / frame caps by default: every carousel slide, every carousel video
// and every qualifying frame is processed (a 12-slide post listed all 24 of its
// places on slides 11–12). Set OCR_FALLBACK_MAX_FRAMES to cap vision OCR on
// unreadable video frames if cost or run time needs bounding.
const optionalCap = (value: string | undefined): number => Number(value) > 0 ? Number(value) : Number.POSITIVE_INFINITY;
/** Subtitle source preference: creator-written captions, then speech recognition, then machine translation. */
const SUBTITLE_SOURCE_RANK: Record<string, number> = { LC: 0, ASR: 1, MT: 2 };

/**
 * Frames that local OCR saw text in but could not read confidently. A frame
 * qualifies when it has at least 3 word candidates and either fewer than 60%
 * are confident or the mean word confidence is below 70. Frames where
 * Tesseract found no words are skipped: they almost never contain text, and
 * sending them would pay for empty results.
 */
export function selectFramesForVisionFallback(ocrFrames: ApifyOcrFrameResult[], max: number): number[] {
  return ocrFrames
    .map((frame) => {
      const stats = frame.wordStats;
      if (!stats || stats.total < 3) return null;
      const confidentRatio = stats.confident / stats.total;
      if (confidentRatio >= 0.6 && stats.meanConfidence >= 70) return null;
      const score = stats.total * (1 - confidentRatio) + (stats.meanConfidence < 70 ? 1 : 0);
      return { frameIndex: frame.frameIndex, score };
    })
    .filter((entry): entry is { frameIndex: number; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, max))
    .map((entry) => entry.frameIndex)
    .sort((a, b) => a - b);
}

// ── Place-intent escalation ────────────────────────────────────────────
// Location-pin stickers ("📍 Buvette") and small overlay labels are too small
// for Tesseract (measured: it reads the large title but not the pins, at both
// native and upscaled resolution). Frame confidence alone therefore cannot
// decide when vision is needed; what the post promises can.

const PLACE_NOUN = String.raw`(?:restaurants?|cafes?|cafés?|coffee\s+shops?|bars?|pubs?|spots?|places?|eater(?:y|ies)|baker(?:y|ies)|pizzerias?|hotels?|beaches|beach(?:es)?|hikes?|trails?|stops?|shops?|stores?|bookstores?|museums?|galleries|rooftops?|speakeasies|gems?|brunch(?:es)?|dinners?|lunch(?:es)?|things\s+to\s+do)`;
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const LIST_PROMISE_RE = new RegExp(String.raw`\b(\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})\s+(?:[\p{L}'’-]+\s+){0,3}?${PLACE_NOUN}\b`, 'iu');
const TOP_N_RE = /\btop\s+(\d{1,2})\b/i;
const PLACE_INTENT_RE = new RegExp(String.raw`\b${PLACE_NOUN}\b|where\s+to\s+(?:eat|go|stay|drink)|must[- ]visit|itinerary|food\s+(?:tour|crawl)|bar\s+crawl|date\s+night|hidden\s+gem|\bguide\b`, 'iu');
const LIST_LINE_RE = /^\s*(?:\d{1,2}\s*[.)\-:]|[•\-–])\s*\S/u;
/** "5 cozy restaurants in…" → 5, "top 10 cafes" → 10, "three spots" → 3. */
export function promisedPlaceCount(texts: string[]): number | null {
  for (const text of texts) {
    const list = text.match(LIST_PROMISE_RE);
    if (list) {
      const value = NUMBER_WORDS[list[1].toLowerCase()] ?? Number(list[1]);
      if (value >= 2 && value <= 30) return value;
    }
    const top = text.match(TOP_N_RE);
    if (top && Number(top[1]) >= 2) return Number(top[1]);
  }
  return null;
}

/** Places the post already names without media: tagged/collab accounts, a location tag, list lines in the caption. */
export function namedPlaceCount(content: SocialContent): number {
  const accounts = (content.accounts || []).filter((account) => account.relation !== 'mention' || account.fullName).length;
  const listLines = (content.caption || '').split(/\r?\n/)
    .filter((line) => LIST_LINE_RE.test(line) || hasLocationMarker(line)).length;
  return accounts + (content.locationTag ? 1 : 0) + listLines;
}

export interface PlaceIntentReport {
  intent: boolean;
  promised: number | null;
  named: number;
  /** True when the text sources already name enough places. */
  covered: boolean;
}

export function describePlaceIntent(content: SocialContent, ocrFrames: ApifyOcrFrameResult[]): PlaceIntentReport {
  const texts = [content.caption || '', ...(content.hashtags || []), ...ocrFrames.flatMap((frame) => (frame.lines || []).map((line) => line.text))];
  const promised = promisedPlaceCount(texts);
  const intent = promised !== null || texts.some((text) => PLACE_INTENT_RE.test(text));
  const named = namedPlaceCount(content);
  return { intent, promised, named, covered: promised !== null ? named >= promised : named > 0 };
}

/**
 * Frames to send to vision OCR because the post promises places that no text
 * source names yet: all of them. Returns [] when the caption/tags already name
 * enough places or the post is not about places.
 */
export function selectFramesForPlaceIntent(content: SocialContent, ocrFrames: ApifyOcrFrameResult[]): number[] {
  if (ocrFrames.length === 0) return [];
  const { intent, covered } = describePlaceIntent(content, ocrFrames);
  if (!intent || covered) return [];
  // Every frame: a place label can be on screen for a single second.
  return ocrFrames.map((frame) => frame.frameIndex).sort((a, b) => a - b);
}

export function resolveFallbackProvider(): FallbackProvider {
  const configured = (process.env.OCR_FALLBACK_PROVIDER || '').trim().toLowerCase();
  if (configured === 'off' || configured === 'none') return 'off';
  const hasOpenAi = !!process.env.OPENAI_API_KEY?.trim();
  if (configured === 'openai') return hasOpenAi ? 'openai' : 'off';
  if (configured === 'google' || !configured) {
    if (GoogleVisionOcrService.isConfigured()) return 'google';
    return hasOpenAi ? 'openai' : 'off';
  }
  return 'off';
}

export function pickSubtitleTrack(tracks: SubtitleTrack[] | undefined, captionLanguage?: string | null): SubtitleTrack | null {
  if (!tracks?.length) return null;
  const language = (captionLanguage || '').toLowerCase().slice(0, 2);
  return [...tracks].sort((a, b) => {
    const rank = (SUBTITLE_SOURCE_RANK[a.source] ?? 9) - (SUBTITLE_SOURCE_RANK[b.source] ?? 9);
    if (rank !== 0) return rank;
    const aLang = a.language.toLowerCase().startsWith(language) ? 0 : 1;
    const bLang = b.language.toLowerCase().startsWith(language) ? 0 : 1;
    return aLang - bLang;
  })[0];
}

async function fetchSubtitleTranscript(content: SocialContent): Promise<TranscriptResult | null> {
  const track = pickSubtitleTrack(content.subtitleTracks, content.captionLanguage);
  if (!track) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(track.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const segments = WhisperService.parseWebVtt(await response.text());
    if (segments.length === 0) return null;
    plog('transcript', 'Using platform subtitles; Whisper skipped', { source: track.source, language: track.language, segments: segments.length });
    return {
      text: segments.map((segment) => segment.text).join(' '),
      language: track.language || null,
      segments,
      source: 'platform-subtitles',
      droppedSegments: 0,
    };
  } catch (error) {
    plog('transcript', 'Platform subtitles unavailable; falling back to Whisper', { error: errorMessage(error) }, 'warn');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Upload extracted audio to S3 (or public/audio locally) and register it in audio_uploads. */
export async function persistAudioUpload(tempAudioPath: string): Promise<AudioUploadRef | null> {
  if (!tempAudioPath || !fs.existsSync(tempAudioPath)) return null;
  try {
    const fileStats = fs.statSync(tempAudioPath);
    const fileName = path.basename(tempAudioPath);
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET_NAME) {
      const s3Url = await S3Service.uploadFile(fs.readFileSync(tempAudioPath), fileName, 'audio/mpeg', 'audios');
      const { data } = await supabaseAdmin
        .from('audio_uploads')
        .insert({
          social_post_id: null,
          file_name: fileName,
          storage_path: `uploads/${fileName}`,
          public_url: s3Url,
          mime_type: 'audio/mpeg',
          size_bytes: fileStats.size,
        })
        .select('id, file_name, size_bytes, public_url')
        .single();
      return data ? { id: data.id, fileName: data.file_name, sizeBytes: data.size_bytes, publicUrl: data.public_url } : null;
    }
    const audioUuid = uuidv4();
    const publicAudioDir = path.join(process.cwd(), 'public', 'audio');
    if (!fs.existsSync(publicAudioDir)) fs.mkdirSync(publicAudioDir, { recursive: true });
    const localFileName = `${audioUuid}.mp3`;
    fs.copyFileSync(tempAudioPath, path.join(publicAudioDir, localFileName));
    return { id: audioUuid, fileName, sizeBytes: fileStats.size, publicUrl: `/audio/${localFileName}` };
  } catch (error) {
    plog('media', 'Audio upload failed (non-fatal)', { error: errorMessage(error) }, 'warn');
    return null;
  }
}

type MediaItem = { kind: 'video' | 'image'; url: string };

function httpsUrl(value: unknown): string {
  return typeof value === 'string' && /^https:\/\//i.test(value.trim()) ? value.trim() : '';
}

/** Normalize the post's media into a list: one video, carousel slides, or a single image. */
interface InstagramChildPost { type?: string; videoUrl?: unknown; displayUrl?: unknown; url?: unknown }

export function mediaItemsFor(content: SocialContent, raw: unknown): MediaItem[] {
  const isVideo = !!content.videoUrl && (content.contentType === 'video' || content.contentType === 'reel');
  if (isVideo) return [{ kind: 'video', url: content.videoUrl! }];

  const childPosts = (raw as { childPosts?: unknown } | null | undefined)?.childPosts;
  const children: InstagramChildPost[] = content.platform === 'instagram' && Array.isArray(childPosts) ? childPosts : [];
  if (children.length > 0) {
    const videos = children
      .filter((child) => child?.type === 'Video' && httpsUrl(child?.videoUrl))
      .map((child) => ({ kind: 'video' as const, url: httpsUrl(child.videoUrl) }));
    const images = children
      .filter((child) => !(child?.type === 'Video' && httpsUrl(child?.videoUrl)))
      .map((child) => httpsUrl(child?.displayUrl) || httpsUrl(child?.url))
      .filter(Boolean)
      .map((url) => ({ kind: 'image' as const, url }));
    return [...videos, ...images];
  }

  const images = (content.images?.length ? content.images : [content.displayUrl])
    .map(httpsUrl)
    .filter(Boolean);
  return [...new Set(images)].map((url) => ({ kind: 'image' as const, url }));
}

export class MediaEvidenceService {
  /**
   * Collect OCR and speech evidence for a post. Every stage is optional: a
   * failed download, OCR, or transcription degrades to fewer signals instead of
   * failing the post.
   */
  static async collect(
    content: SocialContent,
    raw: unknown,
    options: { persistAudio?: boolean } = {}
  ): Promise<MediaEvidenceResult> {
    const persistAudio = options.persistAudio !== false;
    const items = mediaItemsFor(content, raw);
    const frames: VideoFrame[] = [];
    const cleanupFrameSets: VideoFrame[][] = [];
    const cleanupFiles: string[] = [];
    const transcripts: TranscriptResult[] = [];
    let audioUpload: AudioUploadRef | null = null;
    let ocrFrames: ApifyOcrFrameResult[] = [];
    let visionFrames: GptVisionFrameResult[] = [];
    const transcriptStart = Date.now();
    let transcriptMs = 0;
    const ocrStart = Date.now();
    let frameNote = '';
    plog('media', 'Media plan', {
      platform: content.platform,
      contentType: content.contentType,
      durationSec: content.videoDuration,
      items: items.map((item) => item.kind),
      subtitleTracks: content.subtitleTracks?.length || 0,
    });

    try {
      const singleVideo = items.length === 1 && items[0].kind === 'video';

      // Videos: download once, then frames + audio + subtitles in parallel.
      const videoItems = items.filter((item) => item.kind === 'video');
      for (const item of videoItems) {
        const videoPath = await MediaService.downloadVideo(item.url).catch((error: unknown) => {
          plog('media', 'Video download failed (non-fatal)', { error: errorMessage(error) }, 'warn');
          return null;
        });
        if (!videoPath) continue;
        cleanupFiles.push(videoPath);

        const subtitlesPromise = singleVideo ? fetchSubtitleTranscript(content) : Promise.resolve(null);
        const [videoFrames, audioPath, subtitles] = await Promise.all([
          VideoFrameService.extractKeyFrames(videoPath)
            .catch((error: unknown) => {
              plog('frames', 'Frame extraction failed (non-fatal)', { error: errorMessage(error) }, 'warn');
              return [] as VideoFrame[];
            }),
          MediaService.extractAudio(videoPath).catch(() => ''),
          subtitlesPromise,
        ]);
        if (audioPath) cleanupFiles.push(audioPath);
        cleanupFrameSets.push(videoFrames);
        const offset = frames.length;
        frames.push(...videoFrames.map((frame, i) => ({ ...frame, frameIndex: offset + i })));
        if (singleVideo) frameNote = `${videoFrames.length} key frames`;

        let transcript = subtitles;
        if (!transcript && audioPath) {
          transcript = await WhisperService.transcribe(audioPath).catch((error: unknown) => {
            plog('transcript', 'Whisper failed (non-fatal)', { error: errorMessage(error) }, 'warn');
            return null;
          });
        }
        if (transcript) transcripts.push(transcript);
        if (persistAudio && audioPath && !audioUpload) audioUpload = await persistAudioUpload(audioPath);
      }
      transcriptMs = Date.now() - transcriptStart;

      // Images (carousel slides / single post).
      const imageItems = items.filter((item) => item.kind === 'image');
      const imageFrames = await Promise.all(imageItems.map(async (item) => {
        try {
          const filePath = await MediaService.downloadImage(item.url);
          cleanupFiles.push(filePath);
          const visionPath = await VideoFrameService.createVisionCopy(filePath).catch((error: unknown) => {
            plog('media', 'Vision image resize failed; using original image', { error: errorMessage(error) }, 'warn');
            return filePath;
          });
          if (visionPath !== filePath) cleanupFiles.push(visionPath);
          const hash = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
          return { frameIndex: 0, timestamp: 0, filePath, colorFilePath: visionPath, hash } as VideoFrame;
        } catch (error) {
          plog('media', 'Image download failed (non-fatal)', { url: item.url.slice(0, 80), error: errorMessage(error) }, 'warn');
          return null;
        }
      }));
      const imageFrameIndexes: number[] = [];
      for (const frame of imageFrames) {
        if (!frame) continue;
        imageFrameIndexes.push(frames.length);
        frames.push({ ...frame, frameIndex: frames.length });
      }
      if (!frameNote) frameNote = `${frames.length} image/frame(s)`;

      // Start both engines on the exact same complete frame set. GPT Vision
      // therefore does not wait for low-confidence Tesseract output and a
      // venue label visible for only one second is still inspected.
      if (frames.length > 0) {
        const localOcr = ApifyOcrService.extractTextFromFrames(frames, false, frames.length).catch((error: unknown) => {
          plog('ocr', 'Local OCR failed (non-fatal)', { error: errorMessage(error) }, 'warn');
          return [] as ApifyOcrFrameResult[];
        });
        const fullFrameVision = useFullFrameGptVision();
        const gptVisionPromise: Promise<GptVisionFrameResult[]> | null = fullFrameVision
          ? this.runFullFrameGptVision(frames)
          : null;

        ocrFrames = await localOcr;
        plog('ocr', 'Local OCR results', {
          frames: ocrFrames.map((frame) => ({
            t: Math.round(frame.timestamp * 10) / 10,
            lines: (frame.lines || []).map((line) => `${line.text} (${line.confidence})`),
            words: frame.wordStats,
          })),
        });
        visionFrames = gptVisionPromise
          ? await gptVisionPromise
          : await this.runVisionFallback(frames, ocrFrames, content, imageFrameIndexes);
      }
    } finally {
      for (const set of cleanupFrameSets) VideoFrameService.cleanupFrames(set);
      MediaService.cleanupFiles(cleanupFiles);
    }

    const transcript = mergeTranscripts(transcripts);
    const warnings = [...new Set(
      visionFrames.flatMap((frame) => frame.warning?.message ? [frame.warning.message] : [])
    )];
    const visionFrameCount = visionFrames.length;
    const dualOcr = useFullFrameGptVision();
    plog('transcript', transcript ? 'Transcript' : 'No transcript', transcript ? {
      source: transcript.source,
      language: transcript.language,
      segments: transcript.segments.length,
      dropped: transcript.droppedSegments,
      text: transcript.text.slice(0, 500),
    } : undefined);
    plog('media', 'Media done', { frames: frames.length, ocrFrames: ocrFrames.length, visionFrames: visionFrames.length, audioUploaded: !!audioUpload });
    if (warnings.length > 0) {
      plog('media', 'Media completed with non-fatal OCR warning', { warnings, tesseractFrames: ocrFrames.length }, 'warn');
    }
    const steps: PipelineStep[] = [
      {
        step: 2,
        name: 'Transcript',
        status: transcript ? 'success' : 'skipped',
        durationMs: transcriptMs,
        details: transcript
          ? `${transcript.source === 'platform-subtitles' ? 'Platform subtitles' : 'Whisper'} · ${transcript.segments.length} segment(s)` +
            (transcript.droppedSegments ? ` · ${transcript.droppedSegments} dropped (silence/music)` : '')
          : items.some((item) => item.kind === 'video') ? 'No speech detected' : 'No video — skipped',
      },
      {
        step: 3,
        name: 'Frame OCR',
        status: frames.length ? 'success' : 'skipped',
        durationMs: Date.now() - ocrStart - transcriptMs,
        details: frames.length
          ? dualOcr
            ? `${frameNote}; Tesseract + GPT Vision on all ${frames.length} frame(s)` +
              (warnings.length ? '; GPT Vision limit reached — continued with Tesseract OCR' :
                visionFrameCount === frames.length ? '' : ` (${visionFrameCount} GPT result(s))`)
            : `${frameNote}; local OCR` +
              (visionFrameCount ? `; ${visionFrameCount} fallback frame(s) via ${visionFrames[0]?.method}` : '')
          : 'No media to OCR',
      },
    ];

    return {
      ocrFrames,
      visionFrames,
      transcript,
      transcriptText: WhisperService.formatTranscript(transcript),
      audioUpload,
      steps,
      warnings,
    };
  }

  /** Full-frame GPT Vision pass used by the accuracy-first dual-OCR mode. */
  static async runFullFrameGptVision(frames: VideoFrame[]): Promise<GptVisionFrameResult[]> {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      plog('vision', 'Full-frame GPT Vision skipped: OPENAI_API_KEY is not configured', {
        frames: frames.length,
      }, 'warn');
      return [];
    }

    plog('vision', 'Full-frame dual OCR: GPT Vision started for every frame', {
      frames: frames.length,
      firstTimestamp: frames[0]?.timestamp ?? null,
      lastTimestamp: frames[frames.length - 1]?.timestamp ?? null,
      batchSize: 4,
    });
    const results = await GptVisionOcrService.extractTextFromFramesBatched(frames);
    const limitResult = results.find((frame) => frame.warning?.code === 'gpt_vision_limit_exceeded');
    const limitIndex = limitResult ? frames.findIndex((frame) => frame.frameIndex === limitResult.frameIndex) : -1;

    // When GPT Vision exhausts its quota partway through a post, let Cloud
    // Vision inspect the remaining frames rather than discard their text.
    if (limitIndex >= 0 && GoogleVisionOcrService.isConfigured()) {
      const pendingFrames = frames.slice(limitIndex);
      try {
        plog('vision', 'GPT Vision limit reached; continuing remaining frames with Cloud Vision', {
          frames: pendingFrames.length,
          firstTimestamp: pendingFrames[0]?.timestamp ?? null,
        }, 'warn');
        const googleResults = await GoogleVisionOcrService.extractTextFromFrames(pendingFrames);
        const googleByFrame = new Map(googleResults.map((frame) => [frame.frameIndex, frame]));
        const originalByFrame = new Map(results.map((frame) => [frame.frameIndex, frame]));
        const fallbackWarning = {
          code: 'gpt_vision_limit_exceeded' as const,
          message: 'GPT Vision token or rate limit was reached. Cloud Vision OCR continued for the remaining frames.',
        };
        const completed = frames.map((frame, index) => {
          const google = googleByFrame.get(frame.frameIndex);
          if (google) return index === limitIndex ? { ...google, warning: fallbackWarning } : google;
          return originalByFrame.get(frame.frameIndex) || {
            frameIndex: frame.frameIndex,
            timestamp: frame.timestamp,
            texts: [], brands: [], locations: [], prices: [], cta: [],
            description: '', confidence: 0, method: 'gpt-4o-vision' as const,
          };
        });
        plog('vision', 'Cloud Vision completed the GPT-limited frame set', {
          frames: googleResults.length,
          framesWithText: googleResults.filter((frame) => frame.texts.length > 0).length,
        });
        return completed;
      } catch (error) {
        plog('vision', 'Cloud Vision fallback failed; retaining Tesseract OCR', {
          error: errorMessage(error),
          frames: pendingFrames.length,
        }, 'warn');
      }
    }
    plog('vision', 'Full-frame GPT Vision completed', {
      requestedFrames: frames.length,
      returnedFrames: results.length,
      framesWithText: results.filter((frame) => frame.texts.length > 0).length,
    });
    return results;
  }

  /**
   * Selective vision fallback mode (OCR_VISION_MODE=selective):
   * - video frames Tesseract could not read, and list posts with no names in the text;
   * - every image slide (carousels / photo posts). Slides are the content of a
   *   guide post (Instagram allows up to 20); measured on a real 10-slide NYC
   *   guide, Tesseract read none of the small 📍 list text on most slides.
   */
  static async runVisionFallback(
    frames: VideoFrame[],
    ocrFrames: ApifyOcrFrameResult[],
    content?: SocialContent,
    imageFrameIndexes: number[] = []
  ): Promise<GptVisionFrameResult[]> {
    const provider = resolveFallbackProvider();
    const max = optionalCap(process.env.OCR_FALLBACK_MAX_FRAMES);
    const hard = selectFramesForVisionFallback(ocrFrames, max);
    const forIntent = content ? selectFramesForPlaceIntent(content, ocrFrames) : [];
    const selectedIndices = new Set([...hard, ...forIntent, ...imageFrameIndexes]);
    const selected = VideoFrameService.spreadEvenly(
      frames.filter((frame) => selectedIndices.has(frame.frameIndex)),
      Math.max(max, forIntent.length, imageFrameIndexes.length)
    );
    const at = (indices: number[]) => indices.map((index) => Math.round((frames.find((f) => f.frameIndex === index)?.timestamp ?? 0) * 10) / 10);
    plog('vision', selected.length ? `Vision OCR on ${selected.length} frame(s)` : 'Vision OCR not needed', {
      provider,
      unreadableFramesAt: at(hard),
      placeListFramesAt: at(forIntent),
      imageSlides: imageFrameIndexes.length,
      placeIntent: content ? describePlaceIntent(content, ocrFrames) : null,
    });
    if (provider === 'off' || selected.length === 0) return [];

    let results: GptVisionFrameResult[] | null = null;
    if (provider === 'google') {
      try {
        results = await GoogleVisionOcrService.extractTextFromFrames(selected);
      } catch (error) {
        const reason = error instanceof GoogleVisionUnavailableError ? 'unavailable' : 'failed';
        plog('vision', `Cloud Vision ${reason}; falling back to OpenAI vision`, { error: errorMessage(error) }, 'warn');
        if (!process.env.OPENAI_API_KEY?.trim()) return [];
      }
    }
    results = results ?? await GptVisionOcrService.extractTextFromFramesBatched(selected);
    plog('vision', 'Vision OCR results', {
      method: results[0]?.method,
      frames: results.map((frame) => ({ t: Math.round(frame.timestamp * 10) / 10, texts: frame.texts })),
    });
    return results;
  }
}

function mergeTranscripts(transcripts: TranscriptResult[]): TranscriptResult | null {
  const usable = transcripts.filter((transcript) => transcript.text.trim());
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];
  return {
    text: usable.map((transcript) => transcript.text).join('\n'),
    language: usable[0].language,
    // Separate videos: timestamps are not comparable across slides.
    segments: usable.flatMap((transcript) => transcript.segments),
    source: usable[0].source,
    droppedSegments: usable.reduce((sum, transcript) => sum + transcript.droppedSegments, 0),
  };
}
