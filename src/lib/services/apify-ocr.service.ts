import type { VideoFrame, ApifyOcrFrameResult } from '../types/social';

const MAX_FRAMES_FOR_OCR = 60;

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
 * Group confident words into clean text lines.
 */
function buildCleanLines(tsv: string): string[] {
  const words = parseTsv(tsv);

  // Filter by confidence and noise
  const goodWords = words.filter(w =>
    w.conf >= WORD_CONF_THRESHOLD && !isNoise(w.text)
  );

  if (goodWords.length === 0) return [];

  // Group by block+para+line to reconstruct original lines
  const lineMap = new Map<string, string[]>();
  for (const w of goodWords) {
    const key = `${w.blockNum}-${w.parNum}-${w.lineNum}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key)!.push(w.text);
  }

  // Assemble lines and filter out short lines (length < 4) which are almost always noise
  const lines: string[] = [];
  for (const tokens of lineMap.values()) {
    // OCR Typo Correction: Fix "₹15O" -> "₹150"
    const cleanedTokens = tokens.map(token => {
      if (token.includes('₹') && /[Oo]/.test(token)) {
        return token.replace(/[Oo]/g, '0');
      }
      return token;
    });

    const line = cleanedTokens.join(' ').trim();
    if (line.length >= 4) {
      lines.push(line);
    }
  }

  return lines;
}

export class ApifyOcrService {
  static async extractTextFromFrames(
    frames: VideoFrame[],
    skipForSingleImage = false
  ): Promise<ApifyOcrFrameResult[]> {
    if (!frames || frames.length === 0) return [];

    if (skipForSingleImage) {
      console.log('[Local OCR] Skipped — single image post, GPT Vision preferred.');
      return [];
    }

    const framesToProcess = frames.slice(0, MAX_FRAMES_FOR_OCR);
    console.log(`[Local OCR] Starting Tesseract.js OCR on ${framesToProcess.length} frames...`);

    const tesseract = await import('tesseract.js');
    const { createWorker } = tesseract;

    // PSM.AUTO (3) — best general mode; also populates TSV reliably
    const os = require('os');
    const worker = await createWorker('eng+hin', 1, {
      logger: () => { },
      cachePath: os.tmpdir(), // Required for Vercel (read-only FS except for /tmp)
    });

    await worker.setParameters({
      tessedit_pageseg_mode: '3' as any, // PSM.AUTO (3) — better for menus and mixed structured text
    });

    const results: ApifyOcrFrameResult[] = [];

    // Cross-frame dedup: each frame only stores text NEW to that frame
    const globallySeenTexts = new Set<string>();

    for (const frame of framesToProcess) {
      const startMs = Date.now();
      try {
        // Request TSV output — this is the ONLY reliable source of per-word confidence
        const { data } = await worker.recognize(
          frame.filePath,
          {},
          { tsv: true } as any
        );

        const tsv = (data as any).tsv as string | null ?? '';
        const cleanLines = buildCleanLines(tsv);
        const wordCount = parseTsv(tsv).length;

        // Within-frame dedup
        const withinFrameUnique = [...new Set<string>(cleanLines)];

        // Cross-frame dedup: only keep text NOT seen in any previous frame
        const newTextsOnly: string[] = [];
        for (const t of withinFrameUnique) {
          const key = t.toLowerCase().trim().replace(/\s+/g, ' ');
          if (!globallySeenTexts.has(key)) {
            globallySeenTexts.add(key);
            newTextsOnly.push(t);
          }
        }

        const overallConf = data.confidence / 100;

        console.log(
          `[Local OCR] Frame ${frame.frameIndex} @ ${frame.timestamp.toFixed(1)}s → ` +
          `${newTextsOnly.length} NEW lines (${withinFrameUnique.length - newTextsOnly.length} cross-frame dupes removed, ` +
          `words scanned=${wordCount}, conf=${overallConf.toFixed(2)}, took ${Date.now() - startMs}ms)`
        );
        if (newTextsOnly.length > 0) {
          console.log(`[Local OCR] ✓ New text:`, newTextsOnly);
        }

        results.push({
          frameIndex: frame.frameIndex,
          timestamp: frame.timestamp,
          texts: newTextsOnly,
          rawConfidence: overallConf,
          rawResult: {
            text: data.text,
            confidence: data.confidence,
            wordCount,
            goodWordCount: parseTsv(tsv).filter(w => w.conf >= WORD_CONF_THRESHOLD).length,
          },
          method: 'apify-ocr',
        });
      } catch (err) {
        console.error(`[Local OCR] Frame ${frame.frameIndex} failed:`, err);
        results.push({
          frameIndex: frame.frameIndex,
          timestamp: frame.timestamp,
          texts: [],
          rawConfidence: 0,
          rawResult: { error: String(err) },
          method: 'apify-ocr',
        });
      }
    }

    await worker.terminate();

    console.log(`[Local OCR] Done. ${results.length} frames processed.`);
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
