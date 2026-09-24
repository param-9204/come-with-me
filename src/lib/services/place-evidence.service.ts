import * as stringSimilarity from 'string-similarity';
import { LocationService } from './location.service';
import { plog } from './pipeline-log';
import type {
  ApifyOcrFrameResult, EvidenceItem, EvidenceSource, GptVisionFrameResult,
  PlaceCategory, PlaceExtraction, SocialContent, TranscriptResult,
} from '../types/social';

// ──────────────────────────────────────────────────────────────────────
// Tunable constants
// ──────────────────────────────────────────────────────────────────────

/**
 * Prior reliability of each source as support for a place NAME (0–1).
 * These are starting values chosen from how each source behaves (a platform
 * location tag is structured data; OCR has typos; other people's comments are
 * noisy). They are not yet calibrated on labelled data — tune them against a
 * labelled URL set.
 */
export const SOURCE_WEIGHTS = {
  location_tag: 0.9,
  caption: 0.7,
  account_tagged: 0.75,
  account_coauthor: 0.7,
  account_mention: 0.55,
  comment_creator: 0.6,
  vision_ocr: 0.65,
  speech: 0.5,
  /** Posts using a licensed track: transcribed "speech" may be lyrics. */
  speech_over_licensed_music: 0.4,
  alt_text: 0.4,
  comment: 0.25,
  hashtags: 0.3,
  creator_bio: 0.1,
} as const;

/** Local OCR weight = base + slope × line confidence, plus a bonus when seen in 2+ frames. */
const OCR_WEIGHT_BASE = 0.3;
const OCR_WEIGHT_SLOPE = 0.3;
const OCR_REPEAT_BONUS = 0.1;
const OCR_MIN_LINE_CONFIDENCE = 0.45;

/** Candidates below this evidence score are dropped before any Google lookup. */
export const MIN_PLACE_SCORE = 0.4;
const MAX_PLACE_SCORE = 0.95;
const HANDLE_ONLY_CAP = 0.7;
const INDIRECT_CAP = 0.6;
const FUZZY_NAME_THRESHOLD = 0.82;

// Caption, on-screen text and speech are never truncated: a dense "FULL LIST"
// slide can hold 20+ venues with addresses. Only other people's comments are
// limited (they are noisy and rarely name a place).
const MAX_OTHER_COMMENTS = 5;

export const BASE_CATEGORIES = [
  'RESTAURANTS', 'COFFEE', 'TRAVEL', 'ADVENTURE', 'NATURE', 'CITY',
  'SHOPPING', 'NIGHTLIFE', 'CULTURE', 'BARS',
] as const;
export type BaseCategory = (typeof BASE_CATEGORIES)[number];

const HIDDEN_GEM_RE = /hidden gem|secret (?:spot|place|bar|garden|beach|cafe|restaurant)|best[- ]kept secret|locals?[- ]only|off the beaten|underrated|hole[- ]in[- ]the[- ]wall|nobody knows about|hidden spot/i;

/** Platform UI text that OCR picks up from screen recordings and overlays. */
const UI_CHROME_RE = /^(?:follow(?:ing)?|like[sd]?|reply|share|send|save[sd]?|original audio|sponsored|paid partnership(?: with .*)?|see translation|view all \d+ comments|add a comment\.*|tiktok|reels?|instagram|for you|following|live|more|comments?|\d+(?:[.,]\d+)?[km]?)$/i;

const GENERIC_NAMES = new Set([
  'restaurant', 'restaurants', 'cafe', 'coffee shop', 'coffee', 'bar', 'bars', 'pub', 'club', 'hotel', 'shop', 'store',
  'this place', 'this spot', 'the spot', 'spot', 'place', 'my place', 'home', 'my kitchen', 'kitchen', 'hidden gem',
  'bakery', 'market', 'beach', 'park', 'museum', 'rooftop', 'brunch', 'dinner', 'lunch', 'breakfast', 'food',
]);

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface EvidenceBundle {
  items: EvidenceItem[];
  byId: Map<string, EvidenceItem>;
  availability: Record<string, string>;
  context: {
    platform: string;
    contentType: string;
    durationSec: number | null;
    creatorUsername: string;
    creatorFullName: string;
    musicArtist: string;
    musicSong: string;
    licensedAudio: boolean;
  };
}

export interface MediaEvidenceInput {
  ocrFrames?: ApifyOcrFrameResult[];
  visionFrames?: GptVisionFrameResult[];
  /** Legacy/stored OCR strings without frame metadata. */
  ocrTexts?: string[];
  transcript?: TranscriptResult | null;
}

/** Place candidate as returned by the extraction model. */
export interface RawPlaceCandidate {
  name: string;
  mention_type: 'explicit' | 'handle' | 'indirect';
  role: 'featured' | 'recommended' | 'mentioned_only' | 'background';
  name_evidence: string[];
  location_evidence: string[];
  city: string;
  neighborhood: string;
  address: string;
  base_category: BaseCategory;
  category: PlaceCategory;
  description: string;
  search_query: string;
}

export interface ScoredCandidates {
  places: PlaceExtraction[];
  rejected: Array<{ name: string; reason: string }>;
}

// ──────────────────────────────────────────────────────────────────────
// Text normalization & matching
// ──────────────────────────────────────────────────────────────────────

export function normalizeForMatch(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutArticle(value: string): string {
  return value.replace(/^(?:the|a|an|la|le|el|il|los|las|les)\s+/, '');
}

function compact(value: string): string {
  return normalizeForMatch(value).replace(/\s+/g, '');
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function fuzzyContains(haystackNorm: string, needleNorm: string, threshold = FUZZY_NAME_THRESHOLD): boolean {
  if (needleNorm.length < 5) return false;
  const tokens = haystackNorm.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 120) return false;
  const size = needleNorm.split(' ').length;
  for (let windowSize = Math.max(1, size - 1); windowSize <= size + 1; windowSize++) {
    for (let start = 0; start + windowSize <= tokens.length; start++) {
      const window = tokens.slice(start, start + windowSize).join(' ');
      if (Math.abs(window.length - needleNorm.length) > Math.max(3, needleNorm.length * 0.3)) continue;
      if (stringSimilarity.compareTwoStrings(window, needleNorm) >= threshold) return true;
    }
  }
  return false;
}

function looksLikeHandle(name: string): boolean {
  const trimmed = name.trim();
  return /^@?[a-z0-9._]+$/i.test(trimmed) && !/\s/.test(trimmed) && (/[._\d]/.test(trimmed) || trimmed === trimmed.toLowerCase());
}

/** Does this evidence item contain (or identify) the place name? */
export function itemSupportsName(name: string, item: EvidenceItem): boolean {
  const nameNorm = withoutArticle(normalizeForMatch(name.replace(/^@/, '')));
  const nameCompact = nameNorm.replace(/\s+/g, '');
  if (nameCompact.length < 3) return false;

  if (item.source === 'account') {
    const handle = compact(item.username || '');
    if (handle && (handle === nameCompact ||
      (nameCompact.length >= 5 && handle.length >= 5 && (handle.includes(nameCompact) || nameCompact.includes(handle))))) {
      return true;
    }
    const display = withoutArticle(normalizeForMatch(item.displayName || ''));
    if (display && (display === nameNorm || containsPhrase(display, nameNorm) || containsPhrase(nameNorm, display))) return true;
    return !!display && fuzzyContains(display, nameNorm);
  }

  const textNorm = normalizeForMatch(item.text);
  if (containsPhrase(textNorm, nameNorm)) return true;
  if (nameCompact.length >= 6 && textNorm.replace(/\s+/g, '').includes(nameCompact)) return true;
  if (item.source === 'hashtags' || item.source === 'location_tag') return false;
  return fuzzyContains(textNorm, nameNorm);
}

const isScreenText = (item: EvidenceItem) => item.source === 'ocr' || item.source === 'vision_ocr';
const PIN_RE = /^\s*📍/u;
/** Bulleted or numbered lines: a deliberate list, never scenery. */
const LIST_ITEM_RE = /^\s*(?:[•·●▪◦\-–*]|\d{1,2}[.)])\s*\S/u;

// ──────────────────────────────────────────────────────────────────────
// Location markers
// ──────────────────────────────────────────────────────────────────────

/**
 * Pins come in many styles: 📍 📌 🗺️ 🧭 🚩 emoji, map-pin glyphs OCR engines
 * emit for sticker icons (⚲ ⌖), and text labels ("Location:", "Address:",
 * "Located at"). All are normalised to a leading "📍 " so every later step
 * handles one form.
 */
const PIN_GLYPHS = '📍📌🗺🧭🚩⚲⌖';
const PIN_LABELS = String.raw`(?:location|loc|address|addr|addy|where|venue|located\s+at|find\s+(?:us|it)\s+at)`;
const LEADING_MARKER_RE = new RegExp(String.raw`^\s*(?:[${PIN_GLYPHS}]️?\s*[:\-–]?\s*|${PIN_LABELS}\s*[:\-–]\s*|located\s+at\s+)`, 'iu');
const TRAILING_MARKER_RE = new RegExp(String.raw`\s*[${PIN_GLYPHS}]️?\s*$`, 'u');

/** True when the line is marked as a location (any pin style). */
export function hasLocationMarker(line: string): boolean {
  return LEADING_MARKER_RE.test(line) || TRAILING_MARKER_RE.test(line);
}

/** "📌 Buvette", "Location: Buvette", "Buvette 🗺️" → "📍 Buvette"; other lines unchanged. */
export function normalizeLocationMarker(line: string): string {
  const trimmed = line.trim();
  if (LEADING_MARKER_RE.test(trimmed)) {
    const rest = trimmed.replace(LEADING_MARKER_RE, '').trim();
    return rest ? `📍 ${rest}` : trimmed;
  }
  if (TRAILING_MARKER_RE.test(trimmed)) {
    const rest = trimmed.replace(TRAILING_MARKER_RE, '').trim();
    return rest ? `📍 ${rest}` : trimmed;
  }
  return trimmed;
}

export function findNameSupport(name: string, bundle: EvidenceBundle): EvidenceItem[] {
  const direct = bundle.items.filter((item) => itemSupportsName(name, item));
  if (direct.some(isScreenText)) return direct;

  // Signs and overlays are often read as separate lines ("RADIO CITY" /
  // "MUSIC HALL"): also match against all lines read in the same frame.
  const byFrame = new Map<number, EvidenceItem[]>();
  for (const item of bundle.items) {
    if (!isScreenText(item)) continue;
    for (const frame of item.frames || []) byFrame.set(frame, [...(byFrame.get(frame) || []), item]);
  }
  const nameTokens = withoutArticle(normalizeForMatch(name)).split(' ').filter((token) => token.length >= 2);
  const fromFrames = new Set<EvidenceItem>();
  for (const items of byFrame.values()) {
    if (items.length < 2) continue;
    const joined: EvidenceItem = { ...items[0], text: items.map((item) => item.text).join(' ') };
    if (!itemSupportsName(name, joined)) continue;
    for (const item of items) {
      const text = normalizeForMatch(item.text);
      if (nameTokens.some((token) => containsPhrase(text, token))) fromFrames.add(item);
    }
  }
  return [...direct, ...[...fromFrames].filter((item) => !direct.includes(item))];
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'in', 'at', 'on', 'de', 'la', 'le', 'del', 'da', 'di', 'y', 'e', 'a', 'an', 'for', 'by']);

function titleCase(value: string): string {
  return value.split(/\s+/).map((word, index) => {
    // Short all-caps tokens are acronyms: NYC, BBQ, GAZ.
    if (/^\p{Lu}{2,3}$/u.test(word)) return word;
    return index > 0 && SMALL_WORDS.has(word.toLowerCase())
      ? word.toLowerCase()
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * All-lowercase (subtitles) or all-uppercase (overlays) names: use a mixed-case
 * spelling from the evidence when one exists, otherwise title case. Handles
 * are left alone.
 */
export function bestCasing(name: string, support: EvidenceItem[]): string {
  const isLower = name === name.toLowerCase();
  const isUpper = name === name.toUpperCase();
  if ((!isLower && !isUpper) || (looksLikeHandle(name) && !/\s/.test(name))) return name;
  const target = normalizeForMatch(name);
  const size = name.trim().split(/\s+/).length;
  for (const item of support) {
    for (const text of [item.displayName || '', item.text]) {
      const tokens = text.split(/\s+/).filter(Boolean);
      for (let start = 0; start + size <= tokens.length; start++) {
        const window = tokens.slice(start, start + size).join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’.)]+$/gu, '');
        if (normalizeForMatch(window) !== target) continue;
        if (window !== window.toLowerCase() && window !== window.toUpperCase()) return window;
      }
    }
  }
  return titleCase(name.trim());
}

function cityMentionedIn(city: string, item: EvidenceItem): boolean {
  const cleaned = LocationService.cleanCityName(city);
  const cityNorm = normalizeForMatch(cleaned);
  if (!cityNorm) return false;
  const textNorm = normalizeForMatch(item.text);
  if (containsPhrase(textNorm, cityNorm)) return true;
  if (LocationService.detectCityFromText(item.text) === cleaned) return true;
  const cityCompact = cityNorm.replace(/\s+/g, '');
  if (item.source === 'hashtags' && cityCompact.length >= 4) {
    for (const tag of textNorm.split(' ')) {
      if (tag.includes(cityCompact)) return true;
      if (cityCompact.length >= 5) {
        for (let i = 0; i + cityCompact.length <= tag.length; i++) {
          if (stringSimilarity.compareTwoStrings(tag.slice(i, i + cityCompact.length), cityCompact) >= 0.8) return true;
        }
      }
    }
  }
  return false;
}

function phraseMentionedIn(value: string, item: EvidenceItem): boolean {
  const norm = normalizeForMatch(value);
  if (!norm) return false;
  const textNorm = normalizeForMatch(item.text);
  return containsPhrase(textNorm, norm) || (norm.replace(/\s/g, '').length >= 6 && textNorm.replace(/\s/g, '').includes(norm.replace(/\s/g, '')));
}

const STREET_WORDS = new Set(['st', 'street', 'ave', 'avenue', 'blvd', 'boulevard', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'way', 'ct', 'court', 'pl', 'place', 'pkwy', 'parkway', 'n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);

function addressMentionedIn(address: string, item: EvidenceItem): boolean {
  const norm = normalizeForMatch(address);
  const number = norm.match(/\b\d{1,6}\b/)?.[0];
  if (!number) return phraseMentionedIn(address, item);
  const streetWord = norm.split(' ').find((token) => /[a-z]/.test(token) && token.length >= 3 && !STREET_WORDS.has(token))
    || norm.split(' ').find((token) => /^\d+(?:st|nd|rd|th)$/.test(token));
  const textNorm = normalizeForMatch(item.text);
  return containsPhrase(textNorm, number) && (!streetWord || textNorm.includes(streetWord));
}

// ──────────────────────────────────────────────────────────────────────
// Evidence construction
// ──────────────────────────────────────────────────────────────────────

function isUiChrome(line: string, creatorUsername: string): boolean {
  const value = line.trim();
  if (UI_CHROME_RE.test(value)) return true;
  const creator = compact(creatorUsername);
  if (creator.length >= 3) {
    const lineCompact = compact(value);
    // TikTok/Reels watermark: "@creator", "TikTok @creator", "creator".
    if (lineCompact === creator || lineCompact === `tiktok${creator}` || (value.includes('@') && lineCompact.includes(creator) && value.split(/\s+/).length <= 3)) {
      return true;
    }
  }
  return false;
}

function letterCount(value: string): number {
  return (value.match(/\p{L}/gu) || []).length;
}

function splitLongLine(line: string, max = 320): string[] {
  if (line.length <= max) return [line];
  const parts = line.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    if ((current + ' ' + part).trim().length > max && current) {
      chunks.push(current.trim());
      current = part;
    } else {
      current = `${current} ${part}`.trim();
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.flatMap((chunk) => chunk.length > max * 1.5 ? chunk.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) || [chunk] : [chunk]);
}

type OcrEntry = { text: string; confidence: number; timestamp?: number; frame?: number };
type OcrGroup = { text: string; key: string; confidence: number; timestamps: number[]; frames: number; frameIndexes: number[] };

/** On-screen lines longer than this are prose (book pages, menus, articles), never a place name. */
const MAX_OCR_LINE_WORDS = 14;
const MAX_OCR_LINE_CHARS = 140;

/** Levenshtein distance, stopping early once it exceeds `max`. */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

/**
 * Same on-screen line read slightly differently across frames ("HOP SING" /
 * "HOP SlNG"). Lines whose numbers differ are never merged ("Shop 12" vs
 * "Shop 13", different street numbers).
 */
function isOcrVariant(a: string, b: string): boolean {
  if (a === b) return true;
  const digits = (value: string) => (value.match(/\d+/g) || []).join(' ');
  if (digits(a) !== digits(b)) return false;
  const length = Math.min(a.length, b.length);
  if (length < 6) return false;
  return editDistanceWithin(a, b, length >= 12 ? 2 : 1);
}

function groupOcrLines(entries: OcrEntry[]): OcrGroup[] {
  const groups: OcrGroup[] = [];
  for (const entry of entries) {
    const key = normalizeForMatch(entry.text);
    if (!key) continue;
    const existing = groups.find((group) => isOcrVariant(group.key, key));
    if (existing) {
      existing.frames++;
      if (entry.timestamp !== undefined && !existing.timestamps.includes(entry.timestamp)) existing.timestamps.push(entry.timestamp);
      if (entry.frame !== undefined && !existing.frameIndexes.includes(entry.frame)) existing.frameIndexes.push(entry.frame);
      if (entry.confidence > existing.confidence) {
        existing.confidence = entry.confidence;
        existing.text = entry.text;
      }
    } else {
      groups.push({
        text: entry.text.trim(),
        key,
        confidence: entry.confidence,
        timestamps: entry.timestamp !== undefined ? [entry.timestamp] : [],
        frames: 1,
        frameIndexes: entry.frame !== undefined ? [entry.frame] : [],
      });
    }
  }
  return groups;
}

export function buildEvidence(content: SocialContent, media: MediaEvidenceInput = {}): EvidenceBundle {
  const items: EvidenceItem[] = [];
  const creatorUsername = (content.authorUsername || '').replace(/^@/, '');
  const isSingleVideo = (content.contentType === 'reel' || content.contentType === 'video') && !!content.videoUrl;
  const push = (prefix: string, item: Omit<EvidenceItem, 'id'>) => {
    const count = items.filter((existing) => existing.id.startsWith(prefix) && /^\d+$/.test(existing.id.slice(prefix.length))).length;
    items.push({ ...item, id: `${prefix}${count + 1}` });
  };

  // Caption lines (hashtag-only lines go into the hashtag item).
  const captionLines = (content.caption || '')
    .split(/\r?\n/)
    .map((line) => normalizeLocationMarker(line))
    .filter((line) => line && !line.split(/\s+/).every((token) => token.startsWith('#')))
    .flatMap((line) => splitLongLine(line));
  for (const line of captionLines) push('C', { source: 'caption', text: line, weight: SOURCE_WEIGHTS.caption });

  if (content.locationTag?.name) {
    push('L', { source: 'location_tag', text: content.locationTag.name, weight: SOURCE_WEIGHTS.location_tag });
  }

  for (const account of content.accounts || []) {
    if (account.username.toLowerCase() === creatorUsername.toLowerCase()) continue;
    const weight = account.relation === 'tagged'
      ? SOURCE_WEIGHTS.account_tagged
      : account.relation === 'coauthor' ? SOURCE_WEIGHTS.account_coauthor : SOURCE_WEIGHTS.account_mention;
    push('A', {
      source: 'account',
      text: `@${account.username}${account.fullName ? ` "${account.fullName}"` : ''}`,
      weight,
      username: account.username,
      displayName: account.fullName,
      relation: account.relation,
    });
  }

  // Tesseract lines: prefer per-line confidences; fall back to legacy strings.
  const ocrEntries: OcrEntry[] = [];
  for (const frame of media.ocrFrames || []) {
    const lines = frame.lines?.length
      ? frame.lines
      : (frame.texts || []).map((textLine) => ({ text: textLine, confidence: frame.rawConfidence || 0.6 }));
    for (const line of lines) {
      ocrEntries.push({
        text: normalizeLocationMarker(line.text),
        confidence: line.confidence,
        timestamp: isSingleVideo ? frame.timestamp : undefined,
        frame: frame.frameIndex,
      });
    }
  }
  for (const textLine of media.ocrTexts || []) ocrEntries.push({ text: normalizeLocationMarker(textLine), confidence: 0.6 });

  const visionEntries: OcrEntry[] = [];
  for (const frame of media.visionFrames || []) {
    for (const textLine of frame.texts || []) {
      visionEntries.push({ text: normalizeLocationMarker(textLine), confidence: 0.9, timestamp: isSingleVideo ? frame.timestamp : undefined, frame: frame.frameIndex });
    }
  }

  const usable = (line: string) =>
    letterCount(line) >= 3 &&
    line.length <= MAX_OCR_LINE_CHARS &&
    line.trim().split(/\s+/).length <= MAX_OCR_LINE_WORDS &&
    !isUiChrome(line, creatorUsername);
  const visionGroups = groupOcrLines(visionEntries.filter((entry) => usable(entry.text)));
  const visionKeys = new Set(visionGroups.map((group) => group.key));
  const ocrGroups = groupOcrLines(
    ocrEntries.filter((entry) => usable(entry.text) && entry.confidence >= OCR_MIN_LINE_CONFIDENCE)
  )
    .filter((group) => !visionKeys.has(group.key));

  for (const group of ocrGroups) {
    const weight = Math.min(
      SOURCE_WEIGHTS.vision_ocr,
      OCR_WEIGHT_BASE + OCR_WEIGHT_SLOPE * group.confidence + (group.frames >= 2 ? OCR_REPEAT_BONUS : 0)
    );
    push('O', {
      source: 'ocr',
      text: group.text,
      weight: Math.round(weight * 100) / 100,
      timestamps: group.timestamps.length ? group.timestamps.sort((a, b) => a - b) : undefined,
      frames: group.frameIndexes.length ? group.frameIndexes : undefined,
    });
  }
  for (const group of visionGroups) {
    push('V', {
      source: 'vision_ocr',
      text: group.text,
      weight: SOURCE_WEIGHTS.vision_ocr,
      timestamps: group.timestamps.length ? group.timestamps.sort((a, b) => a - b) : undefined,
      frames: group.frameIndexes.length ? group.frameIndexes : undefined,
    });
  }

  // Licensed music (not the creator's own audio): "speech" may be song lyrics.
  const licensedAudio = !!content.musicInfo && content.musicInfo.uses_original_audio === false;
  const transcript = media.transcript;
  if (transcript?.segments?.length) {
    const timed = transcript.source !== 'stored' && isSingleVideo;
    const segments = transcript.source === 'stored'
      ? transcript.segments.flatMap((segment) => splitLongLine(segment.text, 240).map((textPart) => ({ ...segment, text: textPart })))
      : transcript.segments;
    for (const segment of segments) {
      if (!segment.text.trim()) continue;
      push('S', {
        source: 'speech',
        text: segment.text.trim(),
        weight: licensedAudio ? SOURCE_WEIGHTS.speech_over_licensed_music : SOURCE_WEIGHTS.speech,
        timestamps: timed ? [Math.round(segment.start * 10) / 10, Math.round(segment.end * 10) / 10] : undefined,
      });
    }
  }

  if (content.hashtags?.length) {
    push('H', {
      source: 'hashtags',
      text: content.hashtags.slice(0, 40).map((tag) => `#${String(tag).replace(/^#/, '')}`).join(' '),
      weight: SOURCE_WEIGHTS.hashtags,
    });
  }

  const comments = content.comments || [];
  for (const comment of comments.filter((c) => c.isCreator)) {
    push('K', { source: 'comment_creator', text: comment.text, weight: SOURCE_WEIGHTS.comment_creator });
  }
  const others = comments
    .filter((c) => !c.isCreator && (c.text.split(/\s+/).length >= 2 || /[@📍]/u.test(c.text)))
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, MAX_OTHER_COMMENTS);
  for (const comment of others) push('K', { source: 'comment', text: comment.text, weight: SOURCE_WEIGHTS.comment });

  for (const alt of content.altTexts || []) push('X', { source: 'alt_text', text: alt, weight: SOURCE_WEIGHTS.alt_text });
  if (content.creatorBio?.trim()) {
    push('B', { source: 'creator_bio', text: content.creatorBio.trim().slice(0, 300), weight: SOURCE_WEIGHTS.creator_bio });
  }

  const count = (source: EvidenceSource) => items.filter((item) => item.source === source).length;
  const isVideo = content.contentType === 'reel' || content.contentType === 'video';
  const availability: Record<string, string> = {
    caption: count('caption') ? 'yes' : 'none',
    location_tag: count('location_tag') ? 'yes' : 'none',
    accounts: String(count('account')),
    comments: String(count('comment') + count('comment_creator')),
    on_screen_text: count('ocr') + count('vision_ocr')
      ? `${count('ocr') + count('vision_ocr')} lines`
      : (media.ocrFrames?.length || media.visionFrames?.length ? 'no text found' : 'not available'),
    speech: count('speech')
      ? `${count('speech')} segments (${transcript?.source})`
      : isVideo ? (transcript ? 'no speech detected' : 'not available') : 'no video',
  };

  return {
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    availability,
    context: {
      platform: content.platform,
      contentType: content.contentType,
      durationSec: content.videoDuration ?? null,
      creatorUsername,
      creatorFullName: content.authorFullName || '',
      musicArtist: content.musicInfo?.uses_original_audio ? '' : (content.musicInfo?.artist_name || ''),
      musicSong: content.musicInfo?.uses_original_audio ? '' : (content.musicInfo?.song_name || ''),
      licensedAudio,
    },
  };
}

function formatTimestamps(item: EvidenceItem): string {
  if (!item.timestamps?.length) return '';
  if (item.source === 'speech' && item.timestamps.length === 2) return `${item.timestamps[0]}-${item.timestamps[1]}s`;
  return `t=${item.timestamps.slice(0, 6).map((t) => `${Math.round(t)}s`).join(',')}`;
}

const PROMPT_SOURCE_LABELS: Record<EvidenceSource, string> = {
  caption: 'caption',
  hashtags: 'hashtags',
  location_tag: 'location_tag',
  account: 'account',
  comment_creator: 'comment(creator)',
  comment: 'comment',
  alt_text: 'alt_text',
  creator_bio: 'creator_bio',
  ocr: 'on_screen',
  vision_ocr: 'on_screen_hq',
  speech: 'speech',
};

/** Compact line-per-item evidence block (cheaper in tokens than JSON). */
export function formatEvidenceForPrompt(bundle: EvidenceBundle): string {
  const { context } = bundle;
  const header = [
    `POST platform=${context.platform} type=${context.contentType}` +
      (context.durationSec ? ` duration=${Math.round(context.durationSec)}s` : '') +
      ` creator=@${context.creatorUsername}` + (context.creatorFullName ? ` ("${context.creatorFullName}")` : ''),
    `NOT PLACES: creator @${context.creatorUsername}` +
      (context.creatorFullName ? ` / "${context.creatorFullName}"` : '') +
      (context.musicSong || context.musicArtist ? `; audio track "${context.musicSong}" by "${context.musicArtist}"` : ''),
    `SIGNALS: ${Object.entries(bundle.availability).map(([key, value]) => `${key}=${value}`).join(' ')}`,
    ...(context.licensedAudio && bundle.items.some((item) => item.source === 'speech')
      ? ['AUDIO: the post uses a licensed music track — S lines may be song lyrics, not the creator speaking.']
      : []),
    'EVIDENCE',
  ];
  const lines = bundle.items.map((item) => {
    const meta = [
      item.source === 'account' ? item.relation : '',
      formatTimestamps(item),
      item.source === 'ocr' ? `ocr_conf=${item.weight.toFixed(2)}` : '',
    ].filter(Boolean).join(' ');
    return `${item.id} ${PROMPT_SOURCE_LABELS[item.source]}${meta ? `(${meta})` : ''}: ${item.text}`;
  });
  return [...header, ...(lines.length ? lines : ['(no evidence)'])].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Grounding, scoring, filtering
// ──────────────────────────────────────────────────────────────────────

function itemWeight(item: EvidenceItem): number {
  return item.weight;
}

/** Noisy-OR over the strongest item of each independent source type. */
export function combineSupport(items: EvidenceItem[]): number {
  const bestBySource = new Map<string, number>();
  for (const item of items) {
    const key = item.source === 'vision_ocr' ? 'ocr' : item.source; // same screen text, different engine
    bestBySource.set(key, Math.max(bestBySource.get(key) || 0, itemWeight(item)));
  }
  let miss = 1;
  for (const weight of bestBySource.values()) miss *= 1 - weight;
  return 1 - miss;
}

function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(withoutArticle(normalizeForMatch(name)));
}

function isCreatorOrAudio(name: string, bundle: EvidenceBundle): string | null {
  const nameCompact = compact(name.replace(/^@/, ''));
  const { creatorUsername, creatorFullName, musicArtist, musicSong } = bundle.context;
  if (nameCompact && (nameCompact === compact(creatorUsername) || nameCompact === compact(creatorFullName))) return 'creator account';
  if (nameCompact && (nameCompact === compact(musicArtist) || nameCompact === compact(musicSong))) return 'audio track';
  return null;
}

function isCityName(name: string): boolean {
  const detected = LocationService.detectCityFromText(name);
  return !!detected && normalizeForMatch(LocationService.cleanCityName(name)) === normalizeForMatch(detected);
}

/** Clear location fields the model could not have read from evidence (prevents knowledge-based guesses). */
export function sanitizeCandidateLocation<T extends { city: string; neighborhood: string; address: string }>(
  place: T,
  bundle: EvidenceBundle
): T & { groundedLocationIds: string[] } {
  const next = { ...place };
  const groundedLocationIds = new Set<string>();
  // Account display names ("The New York Times", "Mannahatta NYC") are not
  // statements about where a place is.
  const items = bundle.items.filter((item) => item.source !== 'account');

  if (next.city.trim()) {
    const supporting = items.filter((item) => cityMentionedIn(next.city, item));
    if (supporting.length) supporting.forEach((item) => groundedLocationIds.add(item.id));
    else next.city = '';
  }
  if (next.neighborhood.trim()) {
    const supporting = items.filter((item) => phraseMentionedIn(next.neighborhood, item));
    if (supporting.length) supporting.forEach((item) => groundedLocationIds.add(item.id));
    else next.neighborhood = '';
  }
  if (next.address.trim()) {
    const supporting = items.filter((item) => addressMentionedIn(next.address, item));
    if (supporting.length) supporting.forEach((item) => groundedLocationIds.add(item.id));
    else next.address = '';
  }
  return { ...next, groundedLocationIds: [...groundedLocationIds] };
}

const SOURCE_ORDER: EvidenceSource[] = [
  'location_tag', 'account', 'caption', 'vision_ocr', 'ocr', 'speech', 'comment_creator', 'alt_text', 'hashtags', 'comment', 'creator_bio',
];

function describeItems(items: EvidenceItem[], maxSources = Infinity): string {
  const bySource = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const key = item.source === 'vision_ocr' ? 'ocr' : item.source;
    bySource.set(key, [...(bySource.get(key) || []), item]);
  }
  const parts: string[] = [];
  for (const source of SOURCE_ORDER) {
    const group = bySource.get(source);
    if (!group || parts.length >= maxSources) continue;
    // OCR timestamps are separate sightings; speech timestamps are [start, end].
    const times = [...new Set(group
      .flatMap((item) => item.source === 'speech' ? (item.timestamps || []).slice(0, 1) : (item.timestamps || []))
      .map((t) => `${Math.round(t)}s`))].slice(0, 4);
    const timeNote = times.length ? ` (${times.join(', ')})` : '';
    switch (source) {
      case 'account': parts.push(group.map((item) => `${item.relation === 'mention' ? 'mentioned' : item.relation} account @${item.username}`).join(', ')); break;
      case 'location_tag': parts.push('the post location tag'); break;
      case 'ocr': parts.push(`on-screen text${timeNote}`); break;
      case 'speech': parts.push(`speech${timeNote}`); break;
      case 'comment_creator': parts.push("the creator's comment"); break;
      case 'comment': parts.push('a comment'); break;
      case 'alt_text': parts.push('the image description'); break;
      case 'creator_bio': parts.push('the creator bio'); break;
      default: parts.push(`the ${source}`);
    }
  }
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function buildExplanation(nameItems: EvidenceItem[], locationItems: EvidenceItem[], mentionType: string): string {
  const namePart = mentionType === 'indirect'
    ? `Described (not named) in ${describeItems(nameItems)}`
    : `Name found in ${describeItems(nameItems)}`;
  const locationOnly = locationItems.filter((item) => !nameItems.includes(item));
  // The two most reliable location sources are enough to explain it.
  const locationPart = locationOnly.length ? `; location from ${describeItems(locationOnly, 2)}` : '';
  return `${namePart}${locationPart}.`;
}

function snippetsFor(items: EvidenceItem[]): NonNullable<PlaceExtraction['evidence_snippets']> {
  const seen = new Set<string>();
  return items
    .filter((item) => !seen.has(item.id) && seen.add(item.id))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      source: item.source,
      text: item.text.length > 160 ? `${item.text.slice(0, 157)}…` : item.text,
      ...(item.timestamps?.length ? { timestamps: item.timestamps.slice(0, 4) } : {}),
    }));
}

type ScorablePlace = PlaceExtraction & {
  groundedLocationIds?: string[];
  /** The model's raw role; background / mentioned_only are rejected. */
  candidateRole?: RawPlaceCandidate['role'];
};

function scorePlace(place: ScorablePlace, support: EvidenceItem[], bundle: EvidenceBundle): number {
  let score = combineSupport(support);
  const onlyAccounts = support.every((item) => item.source === 'account' || item.source === 'hashtags');
  if (place.mention_type === 'handle' || (onlyAccounts && looksLikeHandle(place.name || ''))) {
    score = Math.min(score, HANDLE_ONLY_CAP);
  }
  const grounded = new Set(place.groundedLocationIds || []);
  if (place.address && grounded.size) score += 0.08;
  else if (place.city && grounded.size) score += 0.05;
  else if (!place.city && !place.address && !place.neighborhood) score -= 0.05;
  if (place.role === 'recommended') score -= 0.03;
  if (place.mention_type === 'indirect') score = Math.min(score, INDIRECT_CAP);
  void bundle;
  return Math.round(Math.max(0, Math.min(MAX_PLACE_SCORE, score)) * 100) / 100;
}

/**
 * Keep only candidates whose name is actually present in the evidence, drop
 * creator/audio/generic/city-context names and background mentions, and
 * replace the model's confidence with an evidence score.
 */
export function scoreAndFilterCandidates(places: ScorablePlace[], bundle: EvidenceBundle): ScoredCandidates {
  const kept: PlaceExtraction[] = [];
  const rejected: ScoredCandidates['rejected'] = [];
  const otherCities = new Set(places.map((p) => normalizeForMatch(LocationService.cleanCityName(p.city))).filter(Boolean));
  // Posts that label their places with location pins ("📍 Buvette"): other
  // screen text (posters, menus, plates) is scenery, not a place.
  // Applies only when the pins themselves name candidates: pins that give an
  // area ("📍 SoHo") must not turn venue names on storefront signs into scenery.
  const isPinned = (item: EvidenceItem) => isScreenText(item) && PIN_RE.test(item.text);
  // Videos only: on designed carousel slides the text is the content (measured
  // on a 10-slide guide, the rule dropped real list entries).
  const isVideo = bundle.context.contentType === 'reel' || bundle.context.contentType === 'video';
  const pinnedCandidates = isVideo
    ? places.filter((place) => !!place.name && findNameSupport(place.name, bundle).some(isPinned)).length
    : 0;
  const pinLabelled = pinnedCandidates >= 2;
  // Local OCR cannot see the 📍 icon (PaddleOCR reads it as a letter, Tesseract
  // drops it). A line it read on frames no vision reader saw has unknown pin
  // status, so it must not count as "un-pinned". Measured on a real reel:
  // Z.ai failed on the two Buvette frames, Paddle read "e Buvette", and the
  // rule dropped a real place.
  const visionReadFrames = new Set(bundle.items.filter((item) => item.source === 'vision_ocr').flatMap((item) => item.frames || []));
  const isPinBlind = (item: EvidenceItem) =>
    item.source === 'ocr' && !!item.frames?.length && item.frames.every((frame) => !visionReadFrames.has(frame));

  for (const place of places) {
    const name = (place.name || '').trim();
    const reject = (reason: string) => rejected.push({ name: name || place.search_query || '(unnamed)', reason });

    let role = place.candidateRole || place.role;
    if (role === 'mentioned_only' && name) {
      // The creator tagged this account on the post: it is part of the guide,
      // not a passing reference, whatever the model's reading of the caption.
      const tagged = findNameSupport(name, bundle).some((item) =>
        item.source === 'account' && (item.relation === 'tagged' || item.relation === 'coauthor'));
      if (tagged) {
        plog('candidates', `"${name}" is tagged by the creator; kept as recommended (model said mentioned_only)`);
        role = 'recommended';
        place.role = 'recommended';
      }
    }
    if (role && !['featured', 'recommended'].includes(role)) { reject(`role:${role}`); continue; }

    let support: EvidenceItem[];
    if (place.mention_type === 'indirect' && !name) {
      // The city is grounded separately (it may come from a hashtag or tag),
      // so only the descriptive words must appear in the evidence text.
      const cityTokens = new Set(normalizeForMatch(`${place.city} ${LocationService.cleanCityName(place.city)}`).split(' '));
      const queryTokens = normalizeForMatch(place.search_query || '')
        .split(' ')
        .filter((token) => token.length >= 3 && !cityTokens.has(token));
      support = bundle.items.filter((item) => {
        const text = normalizeForMatch(item.text);
        const hits = queryTokens.filter((token) => containsPhrase(text, token)).length;
        return queryTokens.length >= 2 && hits / queryTokens.length >= 0.5;
      });
      const allTokens = new Set(support.flatMap((item) => normalizeForMatch(item.text).split(' ')));
      if (queryTokens.length < 2 || queryTokens.some((token) => !allTokens.has(token))) { reject('indirect query not in evidence'); continue; }
    } else {
      if (!name) { reject('empty name'); continue; }
      if (name.length > 70 || name.split(/\s+/).length > 8) { reject('headline, not a name'); continue; }
      if (isGenericName(name)) { reject('generic name'); continue; }
      const excluded = isCreatorOrAudio(name, bundle);
      if (excluded) { reject(excluded); continue; }
      if (isCityName(name) && places.length > 1) { reject('city is location context'); continue; }
      // "Best cafes in Lisbon" → Lisbon is where the places are, not a place itself.
      if (places.length > 1 && otherCities.has(normalizeForMatch(LocationService.cleanCityName(name)))) {
        reject('city is location context'); continue;
      }
      support = findNameSupport(name, bundle);
      if (support.length === 0) { reject('name not found in evidence'); continue; }
      if (support.every((item) => item.source === 'creator_bio')) { reject('only in creator bio'); continue; }
      // A list line ("• Mei Lah Wah", "1. Kasama") is part of the guide even when
      // other places carry pins; only stray text (a poster, a plate) is dropped.
      const isListItem = (item: EvidenceItem) => isScreenText(item) && LIST_ITEM_RE.test(item.text);
      if (pinLabelled && support.every(isScreenText) && !support.some(isPinned) && !support.some(isListItem) && !support.some(isPinBlind)) {
        reject('un-pinned screen text in a pin-labelled post'); continue;
      }
    }

    const score = scorePlace(place, support, bundle);
    if (score < MIN_PLACE_SCORE) { reject(`low evidence score ${score}`); continue; }

    const locationItems = (place.groundedLocationIds || [])
      .map((id) => bundle.byId.get(id))
      .filter((item): item is EvidenceItem => !!item);
    const ordered = [...support].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
    const { groundedLocationIds, candidateRole, ...clean } = place;
    void groundedLocationIds;
    void candidateRole;
    kept.push({
      ...clean,
      name: clean.name ? bestCasing(clean.name, ordered) : clean.name,
      confidence: score,
      evidence_ids: ordered.map((item) => item.id),
      location_evidence_ids: locationItems.map((item) => item.id),
      evidence_sources: [...new Set(ordered.map((item) => item.source))],
      explanation: buildExplanation(ordered, locationItems, place.mention_type || 'explicit'),
      evidence_snippets: snippetsFor([...ordered, ...locationItems]),
    });
  }

  return { places: kept, rejected };
}

// ──────────────────────────────────────────────────────────────────────
// Entity matching (within one post)
// ──────────────────────────────────────────────────────────────────────

export function sameEntity(a: PlaceExtraction, b: PlaceExtraction): boolean {
  const aName = withoutArticle(normalizeForMatch(a.name));
  const bName = withoutArticle(normalizeForMatch(b.name));
  if (!aName || !bName) return false;

  const aCity = normalizeForMatch(LocationService.cleanCityName(a.city));
  const bCity = normalizeForMatch(LocationService.cleanCityName(b.city));
  if (aCity && bCity && aCity !== bCity) return false;

  // Different street numbers = different branches of the same chain.
  const aNumber = normalizeForMatch(a.address).match(/\b\d{1,6}\b/)?.[0];
  const bNumber = normalizeForMatch(b.address).match(/\b\d{1,6}\b/)?.[0];
  if (aNumber && bNumber && aNumber !== bNumber) return false;

  if (aName === bName) return true;
  const aCompact = aName.replace(/\s/g, '');
  const bCompact = bName.replace(/\s/g, '');
  const shorter = aCompact.length <= bCompact.length ? aCompact : bCompact;
  const longer = shorter === aCompact ? bCompact : aCompact;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;
  // Handle vs display name: "joespizzanyc" vs "Joe's Pizza".
  if ((looksLikeHandle(a.name || '') || looksLikeHandle(b.name || '')) && shorter.length >= 5 && longer.includes(shorter)) return true;
  return stringSimilarity.compareTwoStrings(aName, bName) >= 0.88;
}

function preferredName(a: PlaceExtraction, b: PlaceExtraction): string {
  const score = (place: PlaceExtraction) =>
    (looksLikeHandle(place.name || '') ? 0 : 2) +
    ((place.evidence_sources || []).some((source) => source !== 'account' && source !== 'hashtags') ? 1 : 0);
  const aScore = score(a);
  const bScore = score(b);
  if (aScore !== bScore) return (aScore > bScore ? a.name : b.name) || '';
  return ((a.name || '').length >= (b.name || '').length ? a.name : b.name) || '';
}

/** Merge candidates that refer to the same place; evidence is unioned and the score recomputed. */
export function mergeSameEntities(places: PlaceExtraction[], bundle: EvidenceBundle): PlaceExtraction[] {
  const merged: PlaceExtraction[] = [];
  for (const place of places) {
    const index = merged.findIndex((existing) => sameEntity(existing, place));
    if (index < 0) {
      merged.push(place);
      continue;
    }
    const existing = merged[index];
    const evidenceIds = [...new Set([...(existing.evidence_ids || []), ...(place.evidence_ids || [])])];
    const locationIds = [...new Set([...(existing.location_evidence_ids || []), ...(place.location_evidence_ids || [])])];
    const support = evidenceIds.map((id) => bundle.byId.get(id)).filter((item): item is EvidenceItem => !!item);
    const locationItems = locationIds.map((id) => bundle.byId.get(id)).filter((item): item is EvidenceItem => !!item);
    const combined: PlaceExtraction = {
      ...existing,
      name: preferredName(existing, place),
      city: existing.city || place.city,
      neighborhood: existing.neighborhood || place.neighborhood,
      address: existing.address || place.address,
      description: existing.description || place.description,
      mention_type: existing.mention_type === 'explicit' || place.mention_type === 'explicit' ? 'explicit' : existing.mention_type,
      role: existing.role === 'featured' || place.role === 'featured' ? 'featured' : existing.role,
      evidence_ids: evidenceIds,
      location_evidence_ids: locationIds,
      evidence_sources: [...new Set(support.map((item) => item.source))],
    };
    combined.confidence = Math.max(
      existing.confidence,
      place.confidence,
      scorePlace({ ...combined, groundedLocationIds: locationIds }, support, bundle)
    );
    combined.explanation = buildExplanation(support, locationItems, combined.mention_type || 'explicit');
    combined.evidence_snippets = snippetsFor([...support, ...locationItems]);
    merged[index] = combined;
  }
  return merged;
}

// ──────────────────────────────────────────────────────────────────────
// Category
// ──────────────────────────────────────────────────────────────────────

/** HIDDEN GEMS needs explicit creator language; otherwise fall back to what the place is. */
export function resolveHiddenGem(place: PlaceExtraction, bundle: EvidenceBundle): PlaceCategory {
  if (place.category !== 'HIDDEN GEMS') return place.category;
  const relevant = bundle.items.filter((item) =>
    (place.evidence_ids || []).includes(item.id) || item.source === 'caption' || item.source === 'speech' || item.source === 'ocr' || item.source === 'vision_ocr'
  );
  if (relevant.some((item) => HIDDEN_GEM_RE.test(item.text))) return 'HIDDEN GEMS';
  return place.base_category || 'CITY';
}

const TYPE_RULES: Array<[RegExp, BaseCategory | null]> = [
  [/^(?:dessert|ice_cream|donut|juice|candy|chocolate|confectionery|bagel|sandwich)_shop$/, null],
  [/^(?:night_club|dance_hall|karaoke|comedy_club|live_music_venue)$/, 'NIGHTLIFE'],
  [/^(?:bar|pub|wine_bar|cocktail_bar|brewery|brewpub|beer_hall|beer_garden|sports_bar|irish_pub|hookah_bar|lounge_bar)$|_bar$/, 'BARS'],
  [/^(?:cafe|coffee_shop|tea_house|cat_cafe|internet_cafe)$/, 'COFFEE'],
  [/_restaurant$|^(?:restaurant|food_court|diner|steak_house|pizzeria|deli|meal_takeaway|fast_food_restaurant)$/, 'RESTAURANTS'],
  [/^(?:museum|art_gallery|art_studio|performing_arts_theater|cultural_center|cultural_landmark|historical_landmark|historical_place|monument|church|hindu_temple|mosque|synagogue|place_of_worship|library|opera_house|concert_hall|auditorium)$/, 'CULTURE'],
  [/^(?:park|national_park|state_park|hiking_area|beach|garden|botanical_garden|nature_preserve|campground|lake|mountain_peak|scenic_spot|dog_park|woods|river)$/, 'NATURE'],
  [/^(?:amusement_park|water_park|ski_resort|adventure_sports_center|skateboard_park|go_karting_venue|paintball_center|climbing_gym|scuba_diving_center)$/, 'ADVENTURE'],
  [/^(?:lodging|hotel|resort_hotel|motel|hostel|bed_and_breakfast|guest_house|inn|cottage|extended_stay_hotel|budget_japanese_inn|japanese_inn|farmstay|airport|train_station|ferry_terminal)$/, 'TRAVEL'],
  [/^(?:plaza|city_hall|observation_deck|town_square)$/, 'CITY'],
  [/_store$|^(?:store|shopping_mall|market|supermarket|grocery_store|department_store|gift_shop|florist|flea_market|farmers_market|outlet_mall)$/, 'SHOPPING'],
];

export function categoryFromGoogleType(type: string | null | undefined): BaseCategory | null {
  if (!type) return null;
  for (const [pattern, category] of TYPE_RULES) if (pattern.test(type)) return category;
  return null;
}

const VENUE_CATEGORIES = new Set<PlaceCategory>(['RESTAURANTS', 'COFFEE', 'BARS', 'NIGHTLIFE', 'SHOPPING']);

/** Categories that can describe the same venue (a restaurant is often listed by Google as a bar or cafe). */
const CATEGORY_FAMILY: Record<BaseCategory, string> = {
  RESTAURANTS: 'food_drink', COFFEE: 'food_drink', BARS: 'food_drink', NIGHTLIFE: 'food_drink',
  SHOPPING: 'shopping', CULTURE: 'culture', NATURE: 'outdoors', ADVENTURE: 'outdoors', TRAVEL: 'travel', CITY: 'city',
};

/**
 * A Google match whose venue type belongs to a different family than the
 * extracted place (a shoe store for a "restaurant" read off a poster) is the
 * wrong entity — unless the names are identical. Returns the conflicting
 * Google category, or null when consistent/unknown.
 */
export function googleTypeConflict(
  extracted: PlaceCategory | undefined,
  primaryType: string | null | undefined,
  types: string[] | null | undefined
): BaseCategory | null {
  if (!extracted || extracted === 'HIDDEN GEMS') return null;
  const mapped = [primaryType, ...(types || [])].map(categoryFromGoogleType).filter((value): value is BaseCategory => !!value);
  const primary = categoryFromGoogleType(primaryType) || mapped[0];
  if (!primary) return null;
  const family = CATEGORY_FAMILY[extracted as BaseCategory];
  if (mapped.some((category) => CATEGORY_FAMILY[category] === family)) return null;
  // Streets, squares and urban landmarks carry all kinds of Google types.
  if (family === 'city') return null;
  return primary;
}

/**
 * Google's place type is authoritative for what a venue is (a bar is BARS even
 * if a travel reel features it). Experience categories (NATURE, CULTURE,
 * ADVENTURE, TRAVEL, CITY) and HIDDEN GEMS are kept from the evidence, because
 * Google types do not express them reliably.
 */
export function reconcileCategoryWithGoogle(
  category: PlaceCategory,
  primaryType: string | null | undefined,
  types: string[] | null | undefined
): PlaceCategory {
  if (category === 'HIDDEN GEMS') return category;
  const mapped = [primaryType, ...(types || [])].map(categoryFromGoogleType).filter((value): value is BaseCategory => !!value);
  if (mapped.length === 0 || mapped.includes(category as BaseCategory)) return category;
  const primary = categoryFromGoogleType(primaryType) || mapped[0];
  return VENUE_CATEGORIES.has(primary) ? primary : category;
}
