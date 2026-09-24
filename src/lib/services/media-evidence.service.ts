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
import { GlmOcrService, GlmOcrUnavailableError } from './glm-ocr.service';
import { PaddleOcrService } from './paddle-ocr.service';
import { gptVisionModel } from './ai-client';
import { WhisperService } from './whisper.service';
import { S3Service } from './s3.service';
import { errorMessage, patchRun, plog, startStage, stageStatus } from './pipeline-log';
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
}

/**
 * OCR steps, in the order set by OCR_ORDER in .env (default: glm, paddle,
 * google, gpt, tesseract). A step runs only when it is listed and configured:
 * - glm: Z.ai OCR, needs ZAI_API_KEY
 * - paddle: local PaddleOCR, free
 * - tesseract: local, always available; last resort by default
 * - google: Cloud Vision, needs a Google key with the API and billing enabled
 * - gpt: GPT vision, needs USE_GPT_VISION_MODEL and OPENAI_API_KEY
 */
export type OcrStep = 'glm' | 'paddle' | 'tesseract' | 'google' | 'gpt';
const DEFAULT_OCR_ORDER: OcrStep[] = ['glm', 'paddle', 'google', 'gpt', 'tesseract'];
const LOCAL_STEPS: OcrStep[] = ['paddle', 'tesseract'];
const OCR_STEP_ALIASES: Record<string, OcrStep> = {
  glm: 'glm', 'glm-ocr': 'glm', zai: 'glm',
  paddle: 'paddle', paddleocr: 'paddle',
  tesseract: 'tesseract', local: 'tesseract',
  google: 'google', 'google-vision': 'google', 'cloud-vision': 'google',
  gpt: 'gpt', 'gpt-vision': 'gpt', openai: 'gpt',
};

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

/** GPT vision runs only when USE_GPT_VISION_MODEL names a model and an OpenAI key exists. */
function gptVisionAllowed(): boolean {
  return !!gptVisionModel() && !!process.env.OPENAI_API_KEY?.trim();
}

export function ocrOrder(): OcrStep[] {
  const configured = process.env.OCR_ORDER?.trim();
  if (!configured) return [...DEFAULT_OCR_ORDER];
  const steps = configured.toLowerCase().split(/[\s,>]+/).map((name) => OCR_STEP_ALIASES[name]).filter(Boolean);
  return [...new Set(steps)];
}

export function ocrStepAvailable(step: OcrStep): boolean {
  if (step === 'glm') return GlmOcrService.isConfigured();
  if (step === 'google') return GoogleVisionOcrService.isConfigured();
  if (step === 'gpt') return gptVisionAllowed();
  return true;
}

/** Vision steps listed after the first local step: they only see frames local OCR could not settle. */
function stepsAfterLocalOcr(order: OcrStep[] = ocrOrder()): OcrStep[] {
  const index = order.findIndex((step) => LOCAL_STEPS.includes(step));
  return index < 0 ? [] : order.slice(index + 1).filter((step) => !LOCAL_STEPS.includes(step));
}

/** Which local engine read a frame (Paddle results are tagged in rawResult). */
function localEngine(frame: ApifyOcrFrameResult): 'paddle' | 'tesseract' {
  return (frame.rawResult as { engine?: string } | null)?.engine === 'paddle' ? 'paddle' : 'tesseract';
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
        const endDownload = startStage('media_download', 'video');
        const videoPath = await MediaService.downloadVideo(item.url).catch((error: unknown) => {
          plog('media', 'Video download failed (non-fatal)', { error: errorMessage(error) }, 'warn');
          endDownload('failed', { itemsIn: 1, itemsOut: 0, error: errorMessage(error) });
          return null;
        });
        if (!videoPath) continue;
        endDownload('success', { itemsIn: 1, itemsOut: 1 });
        cleanupFiles.push(videoPath);

        const subtitlesPromise = singleVideo ? fetchSubtitleTranscript(content) : Promise.resolve(null);
        const endFrames = startStage('frames', 'ffmpeg');
        const [videoFrames, audioPath, subtitles] = await Promise.all([
          VideoFrameService.extractKeyFrames(videoPath)
            .then((extracted) => {
              endFrames(extracted.length ? 'success' : 'failed', { itemsIn: 1, itemsOut: extracted.length });
              return extracted;
            })
            .catch((error: unknown) => {
              plog('frames', 'Frame extraction failed (non-fatal)', { error: errorMessage(error) }, 'warn');
              endFrames('failed', { itemsIn: 1, itemsOut: 0, error: errorMessage(error) });
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
          const endWhisper = startStage('transcript', 'whisper');
          transcript = await WhisperService.transcribe(audioPath).catch((error: unknown) => {
            plog('transcript', 'Whisper failed (non-fatal)', { error: errorMessage(error) }, 'warn');
            endWhisper('failed', { itemsIn: 1, itemsOut: 0, error: errorMessage(error) });
            return null;
          });
          if (transcript) {
            endWhisper(transcript.text ? 'success' : 'partial', {
              itemsIn: 1,
              itemsOut: transcript.segments.length,
              details: { language: transcript.language, dropped: transcript.droppedSegments },
            });
          }
        } else if (transcript) {
          startStage('transcript', 'platform-subtitles')('success', { itemsIn: 1, itemsOut: transcript.segments.length, details: { language: transcript.language } });
        } else if (!audioPath) {
          startStage('transcript', null)('skipped', { itemsIn: 0, itemsOut: 0, details: { reason: 'no audio track extracted' } });
        }
        if (transcript) transcripts.push(transcript);
        if (persistAudio && audioPath && !audioUpload) audioUpload = await persistAudioUpload(audioPath);
      }
      transcriptMs = Date.now() - transcriptStart;

      // Images (carousel slides / single post).
      const imageItems = items.filter((item) => item.kind === 'image');
      const endImages = imageItems.length ? startStage('media_download', 'image') : null;
      const imageFrames = await Promise.all(imageItems.map(async (item) => {
        try {
          const filePath = await MediaService.downloadImage(item.url);
          cleanupFiles.push(filePath);
          const hash = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
          return { frameIndex: 0, timestamp: 0, filePath, colorFilePath: filePath, hash } as VideoFrame;
        } catch (error) {
          plog('media', 'Image download failed (non-fatal)', { url: item.url.slice(0, 80), error: errorMessage(error) }, 'warn');
          return null;
        }
      }));
      const downloadedImages = imageFrames.filter(Boolean).length;
      endImages?.(stageStatus(imageItems.length, downloadedImages), { itemsIn: imageItems.length, itemsOut: downloadedImages });
      const imageFrameIndexes: number[] = [];
      for (const frame of imageFrames) {
        if (!frame) continue;
        imageFrameIndexes.push(frames.length);
        frames.push({ ...frame, frameIndex: frames.length });
      }
      if (!frameNote) frameNote = `${frames.length} image/frame(s)`;

      if (frames.length > 0) {
        ({ ocrFrames, visionFrames } = await this.runOcrChain(frames, content, imageFrameIndexes));
      }
    } finally {
      for (const set of cleanupFrameSets) VideoFrameService.cleanupFrames(set);
      MediaService.cleanupFiles(cleanupFiles);
    }

    const transcript = mergeTranscripts(transcripts);
    const readers = [
      ...new Set([...ocrFrames.map(localEngine), ...visionFrames.map((frame) => frame.method)]),
    ];
    plog('transcript', transcript ? 'Transcript' : 'No transcript', transcript ? {
      source: transcript.source,
      language: transcript.language,
      segments: transcript.segments.length,
      dropped: transcript.droppedSegments,
      text: transcript.text.slice(0, 500),
    } : undefined);
    plog('media', 'Media done', { frames: frames.length, ocrFrames: ocrFrames.length, visionFrames: visionFrames.length, readers, audioUploaded: !!audioUpload });
    patchRun({
      media_items: items.length,
      ocr_frames: ocrFrames.length,
      vision_frames: visionFrames.length,
      transcript_source: transcript?.source || 'none',
      transcript_language: transcript?.language || null,
    });
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
          ? `${frameNote} · ${readers.join(' → ') || 'no OCR'}`
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
    };
  }

  /**
   * Run the OCR steps in OCR_ORDER, one frame set at a time:
   * - every step reads the frames no earlier step could read (errors,
   *   overload, no balance, not configured);
   * - after the first local step (paddle/tesseract), vision steps also get the
   *   frames the escalation rules pick from its text: carousel slides, frames
   *   it could not read confidently, and list posts whose places the text does
   *   not name;
   * - a local step listed after the vision steps (default: tesseract) is the
   *   last resort for frames nothing else read.
   */
  static async runOcrChain(
    frames: VideoFrame[],
    content: SocialContent,
    imageFrameIndexes: number[]
  ): Promise<{ ocrFrames: ApifyOcrFrameResult[]; visionFrames: GptVisionFrameResult[] }> {
    const order = ocrOrder();
    plog('ocr', 'OCR order', {
      order,
      available: Object.fromEntries(order.map((step) => [step, ocrStepAvailable(step)])),
    });
    const ocrFrames: ApifyOcrFrameResult[] = [];
    const visionFrames: GptVisionFrameResult[] = [];
    let unread = frames;
    // Frames local OCR read that should still get a vision read.
    let escalated: VideoFrame[] = [];
    let localDone = false;

    for (let i = 0; i < order.length; i++) {
      const step = order[i];
      if (LOCAL_STEPS.includes(step)) {
        if (unread.length === 0) continue;
        const read = await this.readLocal(step, unread);
        ocrFrames.push(...read.results);
        const readIndexes = new Set(read.results.map((frame) => frame.frameIndex));
        const readFrames = unread.filter((frame) => readIndexes.has(frame.frameIndex));
        unread = read.failed;
        if (!localDone && read.results.length > 0) {
          localDone = true;
          const laterVision = order.slice(i + 1).filter((later) => !LOCAL_STEPS.includes(later) && ocrStepAvailable(later));
          escalated = this.selectForVision(readFrames, read.results, content, imageFrameIndexes.filter((index) => readIndexes.has(index)), laterVision);
        }
        continue;
      }
      const targets = [...unread, ...escalated].sort((a, b) => a.frameIndex - b.frameIndex);
      if (targets.length === 0) continue;
      const read = await this.readWith(step, targets);
      visionFrames.push(...read.results);
      const done = new Set(read.results.map((frame) => frame.frameIndex));
      unread = unread.filter((frame) => !done.has(frame.frameIndex));
      escalated = escalated.filter((frame) => !done.has(frame.frameIndex));
    }

    if (unread.length) plog('ocr', 'No OCR step could read some frames', { frames: unread.length, at: unread.map((frame) => frame.timestamp) }, 'warn');
    if (escalated.length) plog('vision', 'No vision OCR step read some selected frames; they keep local OCR text only', { frames: escalated.length }, 'warn');
    ocrFrames.sort((a, b) => a.frameIndex - b.frameIndex);
    visionFrames.sort((a, b) => a.frameIndex - b.frameIndex);
    if (ocrFrames.length) {
      plog('ocr', 'Local OCR results', {
        frames: ocrFrames.map((frame) => ({
          t: Math.round(frame.timestamp * 10) / 10,
          engine: localEngine(frame),
          lines: (frame.lines || []).map((line) => `${line.text} (${line.confidence})`),
          words: frame.wordStats,
        })),
      });
    }
    if (visionFrames.length) {
      plog('vision', 'Vision OCR results', {
        methods: [...new Set(visionFrames.map((frame) => frame.method))],
        frames: visionFrames.map((frame) => ({ t: Math.round(frame.timestamp * 10) / 10, method: frame.method, texts: frame.texts })),
      });
    }
    return { ocrFrames, visionFrames };
  }

  /** One local engine; frames it could not read come back in `failed` (all of them if Paddle cannot load). */
  static async readLocal(step: OcrStep, frames: VideoFrame[]): Promise<{ results: ApifyOcrFrameResult[]; failed: VideoFrame[] }> {
    const endStage = startStage('ocr', step);
    const read = await this.readLocalUntimed(step, frames);
    endStage(stageStatus(frames.length, read.results.length), {
      itemsIn: frames.length,
      itemsOut: read.results.length,
      details: { linesRead: read.results.reduce((sum, result) => sum + (result.lines?.length || 0), 0) },
    });
    return read;
  }

  private static async readLocalUntimed(step: OcrStep, frames: VideoFrame[]): Promise<{ results: ApifyOcrFrameResult[]; failed: VideoFrame[] }> {
    if (step === 'paddle') {
      try {
        return await PaddleOcrService.extractTextFromFrames(frames);
      } catch (error) {
        plog('ocr', 'PaddleOCR could not load; frames go to the next OCR step', { error: errorMessage(error) }, 'warn');
        return { results: [], failed: frames };
      }
    }
    const results = await ApifyOcrService.extractTextFromFrames(frames, false, frames.length).catch((error: unknown) => {
      plog('ocr', 'Tesseract failed (non-fatal)', { error: errorMessage(error) }, 'warn');
      return [] as ApifyOcrFrameResult[];
    });
    const read = new Set(results.map((frame) => frame.frameIndex));
    return { results, failed: frames.filter((frame) => !read.has(frame.frameIndex)) };
  }

  /**
   * Frames that should get a vision read after local OCR:
   * - frames local OCR could not read confidently;
   * - list posts with no place names in the caption/tags (every frame);
   * - every image slide (carousels / photo posts). Measured on a stylised
   *   10-slide NYC guide: Tesseract read almost none of the 📍 list text and
   *   PaddleOCR garbled several names ("7 STRER" for 7th Street Burger).
   */
  static selectForVision(
    frames: VideoFrame[],
    ocrFrames: ApifyOcrFrameResult[],
    content: SocialContent | undefined,
    imageFrameIndexes: number[],
    steps: OcrStep[]
  ): VideoFrame[] {
    const max = optionalCap(process.env.OCR_FALLBACK_MAX_FRAMES);
    const hard = selectFramesForVisionFallback(ocrFrames, max);
    const forIntent = content ? selectFramesForPlaceIntent(content, ocrFrames) : [];
    const selectedIndices = new Set([...hard, ...forIntent, ...imageFrameIndexes]);
    const selected = VideoFrameService.spreadEvenly(
      frames.filter((frame) => selectedIndices.has(frame.frameIndex)),
      Math.max(max, forIntent.length, imageFrameIndexes.length)
    );
    const at = (indices: number[]) => indices.map((index) => Math.round((frames.find((f) => f.frameIndex === index)?.timestamp ?? 0) * 10) / 10);
    plog('vision', selected.length ? `Vision OCR wanted on ${selected.length} frame(s) local OCR read` : 'Vision OCR not needed for frames local OCR read', {
      steps,
      unreadableFramesAt: at(hard),
      placeListFramesAt: at(forIntent),
      imageSlides: imageFrameIndexes.length,
      placeIntent: content ? describePlaceIntent(content, ocrFrames) : null,
    });
    return steps.length ? selected : [];
  }

  /** One OCR step on a set of frames; frames it could not read come back in `failed`. */
  static async readWith(step: OcrStep, frames: VideoFrame[]): Promise<{ results: GptVisionFrameResult[]; failed: VideoFrame[] }> {
    const endStage = startStage('vision_ocr', step);
    if (!ocrStepAvailable(step)) {
      plog('vision', `OCR step "${step}" skipped (not configured or unavailable)`, { frames: frames.length });
      endStage('skipped', { itemsIn: frames.length, itemsOut: 0, details: { reason: 'not configured or unavailable' } });
      return { results: [], failed: frames };
    }
    try {
      let read: { results: GptVisionFrameResult[]; failed: VideoFrame[] } | null = null;
      if (step === 'glm') read = await GlmOcrService.extractTextFromFrames(frames);
      if (step === 'google') read = { results: await GoogleVisionOcrService.extractTextFromFrames(frames), failed: [] };
      if (step === 'gpt') read = { results: await GptVisionOcrService.extractTextFromFramesBatched(frames), failed: [] };
      if (read) {
        const withText = read.results.filter((result) => result.texts.length).length;
        endStage(stageStatus(frames.length, read.results.length), { itemsIn: frames.length, itemsOut: read.results.length, details: { withText } });
        return read;
      }
    } catch (error) {
      const unavailable = error instanceof GoogleVisionUnavailableError || error instanceof GlmOcrUnavailableError;
      plog('vision', `OCR step "${step}" ${unavailable ? 'unavailable' : 'failed'}; frames go to the next step`, { error: errorMessage(error) }, 'warn');
      endStage('failed', { itemsIn: frames.length, itemsOut: 0, error: errorMessage(error), details: { unavailable } });
      return { results: [], failed: frames };
    }
    endStage('skipped', { itemsIn: frames.length, itemsOut: 0 });
    return { results: [], failed: frames };
  }

  /** Vision steps on the frames selectForVision picks (used for frames local OCR already read). */
  static async runVisionFallback(
    frames: VideoFrame[],
    ocrFrames: ApifyOcrFrameResult[],
    content?: SocialContent,
    imageFrameIndexes: number[] = [],
    steps: OcrStep[] = stepsAfterLocalOcr()
  ): Promise<GptVisionFrameResult[]> {
    const usable = steps.filter((step) => ocrStepAvailable(step));
    const selected = this.selectForVision(frames, ocrFrames, content, imageFrameIndexes, usable);
    if (usable.length === 0 || selected.length === 0) return [];

    const results: GptVisionFrameResult[] = [];
    let pending = selected;
    for (const step of usable) {
      if (pending.length === 0) break;
      const read = await this.readWith(step, pending);
      results.push(...read.results);
      pending = read.failed;
    }
    if (pending.length) plog('vision', 'No vision OCR step could read some frames; they keep local OCR text only', { frames: pending.length }, 'warn');
    plog('vision', 'Vision OCR results', {
      methods: [...new Set(results.map((frame) => frame.method))],
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
