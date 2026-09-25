import { executeAICall } from './ai-client';
import fs from 'fs';
import type { TranscriptResult, TranscriptSegment } from '../types/social';
import { plog } from './pipeline-log';

interface VerboseSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

// logprob below -1 = failed and compression above 2.4 = repetition loop are
// documented on the OpenAI TranscriptionSegment type. 0.6 is Whisper's own
// default no_speech_threshold.
const LOGPROB_FAILED = -1;
const COMPRESSION_FAILED = 2.4;
const NO_SPEECH_LIKELY = 0.6;

/** Phrases Whisper is known to emit on silence or music-only audio. */
const HALLUCINATION_PATTERNS = [
  /^(?:thank you|thanks)(?: (?:so much|very much))?(?: for watching)?[.!]*$/i,
  /^(?:please )?(?:like and )?subscribe[.!]*$/i,
  /subtitles? (?:by|created by)/i,
  /amara\.org/i,
  /^you[.!]*$/i,
  /^\W*$/,
];

function isHallucination(text: string): boolean {
  const value = text.trim();
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(value));
}

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export class WhisperService {
  /**
   * Keep only segments that are probably real speech. A segment is dropped when
   * it is likely silence (high no-speech probability AND low logprob), when the
   * decoder looped (compression ratio above 2.4), or when it matches a known
   * silence hallucination.
   */
  static filterSegments(segments: VerboseSegment[]): { kept: TranscriptSegment[]; dropped: number } {
    const kept: TranscriptSegment[] = [];
    let dropped = 0;
    for (const segment of segments) {
      const text = (segment.text || '').trim();
      const likelySilence =
        typeof segment.no_speech_prob === 'number' && segment.no_speech_prob > NO_SPEECH_LIKELY &&
        typeof segment.avg_logprob === 'number' && segment.avg_logprob < LOGPROB_FAILED;
      const looped = typeof segment.compression_ratio === 'number' && segment.compression_ratio > COMPRESSION_FAILED;
      if (!text || likelySilence || looped || isHallucination(text)) {
        dropped++;
        continue;
      }
      kept.push({ start: Number(segment.start) || 0, end: Number(segment.end) || 0, text });
    }
    return { kept, dropped };
  }

  /** Parse a WebVTT subtitle file (TikTok `subtitleLinks`) into timed segments. */
  static parseWebVtt(vtt: string): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    const blocks = vtt.replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) continue;
      const [startRaw, endRaw] = lines[timingIndex].split('-->');
      const start = parseTimestamp(startRaw);
      const end = parseTimestamp((endRaw || '').trim().split(/\s+/)[0] || '');
      const text = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (!text || !Number.isFinite(start)) continue;
      segments.push({ start, end: Number.isFinite(end) ? end : start, text });
    }
    return segments;
  }

  /**
   * Transcribe in the original language with segment timestamps. No separate
   * translation call: the extraction model reads multilingual text directly,
   * and translating proper nouns tends to corrupt venue names.
   */
  static async transcribe(audioPath: string): Promise<TranscriptResult> {
    const response = await executeAICall('audio', async ({ client, model }, reportUsage) => {
      const audioStream = fs.createReadStream(audioPath);
      const transcription = await client.audio.transcriptions.create({
        file: audioStream,
        model,
        response_format: 'verbose_json',
      }) as unknown as { text: string; language?: string; segments?: VerboseSegment[] };
      // Transcription APIs generally bill by audio duration, not tokens. The
      // provider does not return billable seconds here, so this row is kept
      // auditable with a null token/cost estimate instead of inventing one.
      reportUsage({ requestSummary: { responseFormat: 'verbose_json' } });
      return transcription;
    });

    const language = (response.language || '').toLowerCase() || null;
    const rawSegments: VerboseSegment[] = Array.isArray(response.segments) && response.segments.length > 0
      ? response.segments
      : [{ start: 0, end: 0, text: response.text || '' }];
    const { kept, dropped } = this.filterSegments(rawSegments);
    plog('transcript', 'Whisper transcription', { language: language || 'unknown', kept: kept.length, dropped });

    return {
      text: kept.map((segment) => segment.text).join(' ').trim(),
      language,
      segments: kept,
      source: 'whisper',
      droppedSegments: dropped,
    };
  }

  /** Transcript text as stored on the post and shown in the UI. */
  static formatTranscript(result: TranscriptResult | null): string {
    if (!result?.text) return '';
    const language = (result.language || '').toLowerCase();
    return language && !['en', 'english'].includes(language) && !language.startsWith('eng')
      ? `[${language}] ${result.text}`
      : result.text;
  }

  /** Rebuild a transcript from a stored plain-text value (older records have no segments). */
  static fromStoredText(text: string | null | undefined): TranscriptResult | null {
    const value = (text || '').trim();
    if (!value) return null;
    // Older records: "Original Transcript:\n…\n\nEnglish Translation:\n…" — keep the original.
    const original = value.match(/Original Transcript:\s*([\s\S]*?)(?:\n\s*\nEnglish Translation:|$)/i)?.[1]?.trim();
    const body = original || value;
    return {
      text: body,
      language: null,
      segments: [{ start: 0, end: 0, text: body }],
      source: 'stored',
      droppedSegments: 0,
    };
  }
}
