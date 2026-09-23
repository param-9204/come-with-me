import os from 'os';
import type { VideoFrame, ApifyOcrFrameResult, OcrLine } from '../types/social';
import { plog } from './pipeline-log';

const MAX_FRAMES_FOR_OCR = 120;
/** Languages loaded into Tesseract. Each extra language slows recognition. */
const OCR_LANGS = process.env.OCR_LANGS?.trim() || 'eng+hin';

const WORD_CONF_THRESHOLD = 60;

const MIN_TOKEN_LENGTH = 2;
interface TsvWord {
  blockNum: number;
  parNum: number;
  lineNum: number;
  conf: number;
  text: string;
}

function parseTsv(tsv: string): TsvWord[] {
  const lines = tsv.split('\n').slice(1); // skip header
  const words: TsvWord[] = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 12) continue;

    const level = parseInt(parts[0], 10);
    if (level !== 5) continue; // only word-level rows

    const conf = parseInt(parts[10], 10);
    const text = parts[11]?.trim() ?? '';

    if (conf < 0 || !text) continue; // skip spacers

    words.push({
      blockNum: parseInt(parts[2], 10),
      parNum: parseInt(parts[3], 10),
      lineNum: parseInt(parts[4], 10),
      conf,
      text,
    });
  }

  return words;
}

function isNoise(word: string): boolean {
  const t = word.trim();
  if (t.length < MIN_TOKEN_LENGTH) return true;
  // No letters or numbers at all (in any language/script) — pure symbol token
  if (!/(\p{L}|\p{N})/u.test(t)) return true;
  // Contains high-noise symbols
  if (/[§\\{}*|<>~`^]/.test(t)) return true;
  // Standalone Roman numerals (e.g. 'II', 'III', 'IV' as lone tokens)
  if (/^[IVXivx]{1,4}$/.test(t)) return true;
  return false;
}

/**
 * Group confident words into clean text lines, each with the mean confidence
 * (0–1) of its words.
 */
export function buildConfidentLines(tsv: string): OcrLine[] {
  const words = parseTsv(tsv);

  // Filter by confidence and noise
  const goodWords = words.filter(w =>
    w.conf >= WORD_CONF_THRESHOLD && !isNoise(w.text)
  );

  if (goodWords.length === 0) return [];

  // Group by block+para+line to reconstruct original lines
  const lineMap = new Map<string, TsvWord[]>();
  for (const w of goodWords) {
    const key = `${w.blockNum}-${w.parNum}-${w.lineNum}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key)!.push(w);
  }

  // Assemble lines and filter out short lines (length < 4) which are almost always noise
  const lines: OcrLine[] = [];
  for (const lineWords of lineMap.values()) {
    // OCR Typo Correction: Fix "₹15O" -> "₹150"
    const cleanedTokens = lineWords.map(({ text: token }) => {
      if (token.includes('₹') && /[Oo]/.test(token)) {
        return token.replace(/[Oo]/g, '0');
      }
      return token;
    });

    const line = cleanedTokens.join(' ').trim();
    if (line.length >= 4) {
      const confidence = lineWords.reduce((sum, w) => sum + w.conf, 0) / lineWords.length / 100;
      lines.push({ text: line, confidence: Math.round(confidence * 100) / 100 });
    }
  }

  return lines;
}

/** Word statistics over non-noise words; a frame full of low-confidence words is a vision-OCR candidate. */
export function wordStatsFromTsv(tsv: string): { total: number; confident: number; meanConfidence: number } {
  const words = parseTsv(tsv).filter((w) => !isNoise(w.text));
  const confident = words.filter((w) => w.conf >= WORD_CONF_THRESHOLD).length;
  const meanConfidence = words.length ? words.reduce((sum, w) => sum + w.conf, 0) / words.length : 0;
  return { total: words.length, confident, meanConfidence: Math.round(meanConfidence) };
}

/**
 * Preserve source lines such as "Paul's - 283 Nostrand Ave" when Tesseract's
 * per-word confidence filter keeps the address but drops the venue name. The
 * address shape is mandatory, so noisy prose is never promoted as a place.
 */
function extractStructuredVenueAddressLines(rawText: string): string[] {
  const streetSuffix = '(?:st|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway)\\.?';
  const addressPattern = new RegExp(`^\\d{1,6}\\s+.+?\\b${streetSuffix}\\b.*$`, 'i');
  const output: string[] = [];

  for (const sourceLine of rawText.split(/\r?\n/)) {
    const match = sourceLine.match(/^\s*(.{2,100}?)\s*[-*]\s*(\d{1,6}\s+.+)$/);
    if (!match) continue;

    const name = match[1]
      .replace(/^[^A-Za-z0-9]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const address = match[2].replace(/\s+/g, ' ').trim();
    if (!name || !/[A-Za-z]/.test(name) || !addressPattern.test(address)) continue;

    output.push(`${name} - ${address}`);
  }

  return [...new Set(output)];
}

export class ApifyOcrService {
  static async extractTextFromFrames(
    frames: VideoFrame[],
    skipForSingleImage = false,
    maxFrames = MAX_FRAMES_FOR_OCR
  ): Promise<ApifyOcrFrameResult[]> {
    if (!frames || frames.length === 0) return [];

    if (skipForSingleImage) {
      console.log('[Local OCR] Skipped — single image post, GPT Vision preferred.');
      return [];
    }

    const framesToProcess = [...frames.slice(0, maxFrames)].sort((a, b) => a.frameIndex - b.frameIndex);
    const workerCount = Math.max(1, Math.min(
      Number(process.env.OCR_WORKERS) || Math.min(4, os.cpus().length || 1),
      framesToProcess.length
    ));
    plog('ocr', 'Tesseract started', { languages: OCR_LANGS, frames: framesToProcess.length, workers: workerCount });

    const tesseract = await import('tesseract.js');
    const { createWorker } = tesseract;

    // Workers are created once per request and shared by all frames; creating
    // one per frame reloads the language data every time.
    const workers = await Promise.all(Array.from({ length: workerCount }, async () => {
      const worker = await createWorker(OCR_LANGS, 1, {
        logger: () => { },
        cachePath: os.tmpdir(), // Required for Vercel (read-only FS except for /tmp)
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '3' as any, // PSM.AUTO (3) — better for menus and mixed structured text
      });
      return worker;
    }));

    type Recognized = { frame: VideoFrame; lines: OcrLine[]; stats: ReturnType<typeof wordStatsFromTsv>; text: string; confidence: number; error?: string };
    const recognized: Recognized[] = new Array(framesToProcess.length);
    let next = 0;
    await Promise.all(workers.map(async (worker) => {
      while (next < framesToProcess.length) {
        const index = next++;
        const frame = framesToProcess[index];
        try {
          // Request TSV output — this is the ONLY reliable source of per-word confidence
          const { data } = await worker.recognize(frame.filePath, {}, { tsv: true } as any);
          const tsv = (data as any).tsv as string | null ?? '';
          const confidentLines = buildConfidentLines(tsv);
          // Keep valid venue-address lines from raw OCR as evidence when
          // confidence filtering removed only the venue name.
          const structured = extractStructuredVenueAddressLines(data.text || '')
            .filter((line) => !confidentLines.some((existing) => existing.text === line))
            .map((line) => ({ text: line, confidence: Math.max(0.5, data.confidence / 100) }));
          const lines = [...confidentLines, ...structured];
          const stats = wordStatsFromTsv(tsv);
          // Per-frame lines are logged once, as a summary, by the media pipeline.
          recognized[index] = { frame, lines, stats, text: data.text || '', confidence: data.confidence };
        } catch (err) {
          plog('ocr', `Frame ${frame.frameIndex} failed`, { error: String(err) }, 'error');
          recognized[index] = { frame, lines: [], stats: { total: 0, confident: 0, meanConfidence: 0 }, text: '', confidence: 0, error: String(err) };
        }
      }
    }));
    await Promise.all(workers.map((worker) => worker.terminate()));

    // Cross-frame dedup in chronological order: `texts` holds only lines new
    // to each frame (legacy consumers); `lines` keeps everything per frame so
    // repeated sightings can raise confidence downstream.
    const globallySeenTexts = new Set<string>();
    const results: ApifyOcrFrameResult[] = recognized.map(({ frame, lines, stats, text, confidence, error }) => {
      const newTextsOnly: string[] = [];
      for (const { text: line } of lines) {
        const key = line.toLowerCase().trim().replace(/\s+/g, ' ');
        if (!globallySeenTexts.has(key)) {
          globallySeenTexts.add(key);
          newTextsOnly.push(line);
        }
      }
      return {
        frameIndex: frame.frameIndex,
        timestamp: frame.timestamp,
        texts: newTextsOnly,
        rawConfidence: confidence / 100,
        rawResult: error
          ? { error }
          : { text, confidence, wordCount: stats.total, goodWordCount: stats.confident },
        method: 'apify-ocr' as const,
        lines,
        wordStats: stats,
      };
    });

    plog('ocr', 'Tesseract done', { frames: results.length, linesRead: results.reduce((sum, r) => sum + (r.lines?.length || 0), 0) });
    return results.sort((a, b) => a.frameIndex - b.frameIndex);
  }

  /**
   * Collapse all frame results into a single deduplicated text list.
   */
  static deduplicateAcrossFrames(results: ApifyOcrFrameResult[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];

    for (const r of results) {
      for (const t of r.texts) {
        const key = t.toLowerCase().trim().replace(/\s+/g, ' ');
        if (key.length >= MIN_TOKEN_LENGTH && !seen.has(key)) {
          seen.add(key);
          output.push(t.trim());
        }
      }
    }

    return output;
  }
}
