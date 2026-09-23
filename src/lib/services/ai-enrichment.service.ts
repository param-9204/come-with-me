import { getAIClient, executeAICall } from './ai-client';
import { LocationService } from './location.service';
import type { SocialContent, AiAnalysisResult, PlaceExtraction } from '../types/social';
import * as stringSimilarity from 'string-similarity';
import { removeStopwords, eng } from 'stopword';
import nlp from 'compromise';

const PLACE_CATEGORIES = [
  'RESTAURANTS', 'COFFEE', 'TRAVEL', 'ADVENTURE', 'NATURE', 'CITY',
  'SHOPPING', 'NIGHTLIFE', 'CULTURE', 'HIDDEN GEMS', 'BARS',
] as const;

// Provider wire format uses integer percentages so Groq can enforce one
// homogeneous strict enum. Values are converted back to app decimals below.
const PLACE_CONFIDENCE_CODES = [60, 80, 100] as const;
type PlaceConfidenceCode = (typeof PLACE_CONFIDENCE_CODES)[number];

const PLACE_SYSTEM_PROMPT = `You extract map-ready places from social posts. Return every distinct physical place the creator visits, features, recommends, or lists as a stop (including bonus/last/extra/also). Return {"places":[]} only when none is supported.

SOURCE PRIORITY
1) caption  2) OCR / on-screen text  3) audio transcript  4) tagged business accounts
Mentions/handles identify a stop; they are NOT the stored display name.

NAME
- Prefer the real venue name from OCR, signs, or caption prose (e.g. "Blue Bottle Coffee").
- If no display name is present, use the directly associated business @handle without @; never use a promotional headline as the name.
- Never store a bare @handle as name when a display name for that stop exists in INPUT.
- Handle-without-@ is last resort only.
- Name must be only the venue's exact display name—not surrounding caption text, promotional copy, labels, hashtags, rankings, or calls to action. If INPUT cannot isolate the display name, skip the place rather than modify or guess it.
- Skip people, DJs/artists/hosts, dishes, apps, generic unnamed spots, background refs.

ADDRESS (critical — most common failure)
- Hunt aggressively for street addresses near each stop in caption, OCR, and transcript.
- Capture ALL of these forms when present:
  • "142 N. 2nd Street" / "142 North 2nd St"
  • short forms in parentheses: "(140 N. 2nd)", "(400 Ranstead)"
  • "located at …", "at …", "address:", pin emoji lines
  • number + direction + street: "140 N 2nd", "209 Chestnut St"
- Put the street line in "address" (keep number + street text). Do NOT leave address "" if a street number for that stop appears anywhere in INPUT.
- Copy a complete stated Address/location line, including landmarks and road names. Never turn a size, height, price, date, or offer into an address or invent "Street".
- Pair each address with the nearest place/handle in the same sentence, parentheses, or bullet.
- Never invent a street number that is not written in INPUT.
- Never copy one stop's address onto a different stop.

CITY / NEIGHBORHOOD
- For a clear single-city itinerary/tour, apply that shared city (and neighborhood when stated) to stops that omit city.
- Multi-city or conflicting stops: keep each stop's own city; if unclear, city "".
- Street addresses in a single-city itinerary inherit that city when city is established in INPUT.
- Do not invent cities absent from INPUT (direct text, hashtag, or location handle).

category: exactly one of ${PLACE_CATEGORIES.join(', ')}.
description: one short supported fact or "".
creator_handle: exactly author_username.
confidence: 100 = name + street address (or name + explicit full location), 80 = named stop with city/neighborhood only, 60 = handle-only / weak location.

Return one JSON object only: {"places":[...]}.
Each item: name, city, neighborhood, address, category, description, creator_handle, confidence.
Non-confidence values are strings; unknown = "". No markdown, prose, nulls, or extra keys.`;

type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : null;
}

/** Reject metadata-bearing names instead of trying to rewrite an unknown venue name. */
function normalizePlaceName(value: unknown): string | null {
  const name = normalizeString(value);
  if (!name || name.includes('#')) return null;
  return name;
}

/** Keep malformed or unexpected shapes out of the place-saving path. */
function normalizePlace(value: unknown, authorUsername: string): PlaceExtraction | null {
  if (!isRecord(value)) return null;

  const name = normalizePlaceName(value.name);
  const city = normalizeString(value.city);
  const neighborhood = normalizeString(value.neighborhood);
  const address = normalizeString(value.address);
  const description = normalizeString(value.description);
  const category = normalizeString(value.category);
  const rawConfidence = value.confidence;
  // Groq JSON mode can represent an otherwise valid confidence as 0.6/0.8/1.
  // Convert only the three documented wire equivalents; reject every other value.
  const confidenceCode = typeof rawConfidence === 'number' && rawConfidence > 0 && rawConfidence <= 1
    ? Math.round(rawConfidence * 100)
    : rawConfidence;

  if (
    !name ||
    city === null ||
    neighborhood === null ||
    address === null ||
    description === null ||
    !category ||
    !PLACE_CATEGORIES.includes(category as PlaceCategory) ||
    typeof confidenceCode !== 'number' ||
    !Number.isInteger(confidenceCode) ||
    !PLACE_CONFIDENCE_CODES.includes(confidenceCode as PlaceConfidenceCode)
  ) {
    console.warn('[AI Place Extraction] Dropped a response item that did not match the place schema.');
    return null;
  }

  return {
    name,
    city: LocationService.cleanCityName(city),
    neighborhood,
    address,
    category: category as PlaceCategory,
    description,
    // The creator is input metadata, not a fact the model may generate.
    creator_handle: authorUsername,
    confidence: confidenceCode / 100,
  };
}

function parsePlaceResponse(raw: string, authorUsername: string): PlaceExtraction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('[AI Place Extraction] Model returned invalid JSON.');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.places)) {
    throw new Error('[AI Place Extraction] Model response did not match the required {"places": []} shape.');
  }

  return parsed.places
    .map((place) => normalizePlace(place, authorUsername))
    .filter((place): place is PlaceExtraction => place !== null);
}

function collapseAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeHandleName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  // Single token with no spaces — typical IG/TikTok username storage.
  return /^@?[a-z0-9._]+$/i.test(trimmed);
}

/** Prefer OCR/caption display names over bare @handles when they clearly refer to the same venue. */
function resolveDisplayNameFromSources(name: string, sources: string[]): string {
  if (!looksLikeHandleName(name) || sources.length === 0) return name;

  const handleKey = collapseAlnum(name.replace(/^@/, ''));
  if (handleKey.length < 4) return name;

  const candidates = new Set<string>();
  for (const source of sources) {
    for (const part of source.split(/[\n|;•·]+/)) {
      const trimmed = part.trim();
      if (trimmed.length >= 4 && /\s/.test(trimmed) && trimmed.length <= 80) {
        candidates.add(trimmed.replace(/^[@#]+/, '').trim());
      }
    }
    // Title-like phrases: "Film Society Bourse", "The Gas Lamp Hotel"
    const proper = source.match(/\b(?:[A-Z][a-zA-Z0-9'&.]*\s+){1,5}[A-Z][a-zA-Z0-9'&.]*\b/g) || [];
    for (const phrase of proper) candidates.add(phrase.trim());
    // Softer caption wording: "the Gas Lamp", "a Four Foot Prune"
    const soft = source.match(/\b(?:the|a|an)\s+[A-Z][a-zA-Z0-9'&]*(?:\s+[A-Za-z0-9'&]+){0,4}/g) || [];
    for (const phrase of soft) {
      const cleaned = phrase.replace(/^(?:the|a|an)\s+/i, '').trim();
      if (cleaned.includes(' ')) candidates.add(cleaned);
    }
  }

  let best: { text: string; score: number } | null = null;
  for (const candidate of candidates) {
    const candidateKey = collapseAlnum(candidate);
    if (candidateKey.length < 4) continue;
    const handleStem = handleKey.replace(/(food|phl|nyc|la|the|bar|cafe|hotel|shop|store|official)$/i, '');
    const score =
      candidateKey === handleKey ? 1 :
        candidateKey.includes(handleKey) || handleKey.includes(candidateKey) ? 0.85 :
          (handleStem.length >= 6 && candidateKey.includes(handleStem)) ? 0.8 :
            0;
    if (score < 0.8) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && candidate.length > best.text.length)
    ) {
      best = { text: candidate, score };
    }
  }

  return best?.text || name;
}

/**
 * Fill empty city/neighborhood only for clear single-area itineraries.
 * Conservative on purpose so multi-city / comparison / vlog content is not force-filled.
 */
function looksLikeSingleAreaItinerary(inputBlob: string, placeCount: number): boolean {
  if (placeCount < 2) return false;
  const text = inputBlob.toLowerCase();
  return /(itinerary|first stop|next stop|last stop|bonus stop|then (we|i|you)|from there|walking tour|food crawl|day (in|trip)|first friday|hop(?:ping)? between)/i.test(text)
    || (/(stop\s*\d|^\s*\d+[\.)]\s)/m.test(inputBlob) && placeCount >= 2);
}

function hasStreetAddress(address: string): boolean {
  const value = (address || '').trim();
  if (!value || !/\d/.test(value)) return false;
  if (/(st|street|ave|avenue|blvd|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|#|suite|unit)\b/i.test(value)) {
    return true;
  }
  // Short social forms: "140 N 2nd", "400 Ranstead"
  return /^\d{1,6}\s+[A-Za-z]/.test(value);
}

/** Street lines written in social captions, including short forms like "(140 N. 2nd)". */
const STREET_ADDRESS_RE =
  /\b(\d{1,6}\s+(?:(?:[NSEW]\.|[Nn]orth|[Ss]outh|[Ee]ast|[Ww]est)\s+)?(?:\d+(?:st|nd|rd|th)?|[A-Za-z][\w.'-]*)(?:\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway)\.?)?)\b/gi;

function normalizeAddressCandidate(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*$/, '')
    .replace(/\.$/, '')
    .trim();
}

function isPlausibleStreetAddress(value: string): boolean {
  const normalized = normalizeAddressCandidate(value);
  if (!/^\d{1,6}\s+\S+/.test(normalized)) return false;
  if (normalized.length < 5 || normalized.length > 80) return false;
  // Reject pure years / prices mistaken as addresses.
  if (/^\d{4}$/.test(normalized)) return false;
  return true;
}

function expandShortStreetAddress(address: string): string {
  let next = normalizeAddressCandidate(address);
  // Expand only standalone compass tokens, not letters inside "2nd" / "Street".
  next = next
    .replace(/\bN\.(?=\s|$)/gi, 'North')
    .replace(/\bS\.(?=\s|$)/gi, 'South')
    .replace(/\bE\.(?=\s|$)/gi, 'East')
    .replace(/\bW\.(?=\s|$)/gi, 'West')
    .replace(/\bN\b(?=\s+\d)/gi, 'North')
    .replace(/\bS\b(?=\s+\d)/gi, 'South')
    .replace(/\bE\b(?=\s+\d)/gi, 'East')
    .replace(/\bW\b(?=\s+\d)/gi, 'West');
  // "140 North 2nd" / "400 Ranstead" → add Street when clearly a bare street name
  if (!/\b(street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy)\b/i.test(next)) {
    if (/^\d{1,6}\s+(north|south|east|west)\s+\d+(st|nd|rd|th)?$/i.test(next) ||
      /^\d{1,6}\s+[A-Za-z][A-Za-z.'-]+$/i.test(next)) {
      next = `${next} Street`;
    }
  }
  return next;
}

type FoundAddress = { address: string; index: number; end: number };

function findStreetAddressesInText(text: string): FoundAddress[] {
  if (!text) return [];
  const found: FoundAddress[] = [];
  const re = new RegExp(STREET_ADDRESS_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const candidate = normalizeAddressCandidate(match[1] || match[0]);
    if (!isPlausibleStreetAddress(candidate)) continue;
    found.push({
      address: expandShortStreetAddress(candidate),
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/**
 * Attach missing/incomplete addresses from caption/OCR by proximity to the
 * place name or matching @handle — never invents numbers not present in text.
 */
function attachAddressesFromSources(
  places: PlaceExtraction[],
  sources: string[]
): PlaceExtraction[] {
  const blob = sources.filter(Boolean).join('\n');
  if (!blob || places.length === 0) return places;

  const found = findStreetAddressesInText(blob);
  if (found.length === 0) return places;

  const used = new Set<number>();

  return places.map((place) => {
    const current = (place.address || '').trim();
    if (hasStreetAddress(current) && /\d/.test(current)) {
      // Already has a usable street address; still expand short forms.
      return { ...place, address: expandShortStreetAddress(current) };
    }

    const nameKey = collapseAlnum(place.name || '');
    if (!nameKey) return place;

    // Prefer address in the same window as the place name / handle.
    let best: { addr: FoundAddress; distance: number } | null = null;
    for (let i = 0; i < found.length; i++) {
      if (used.has(i)) continue;
      const addr = found[i];
      const windowStart = Math.max(0, addr.index - 120);
      const windowEnd = Math.min(blob.length, addr.end + 80);
      const window = blob.slice(windowStart, windowEnd);
      const windowKey = collapseAlnum(window);
      const nameNearby =
        windowKey.includes(nameKey) ||
        nameKey.length >= 6 && window.toLowerCase().includes((place.name || '').toLowerCase().replace(/^@/, ''));

      // Also match handle stems inside the window (gaslamphotel near "140 N. 2nd")
      const handleStem = nameKey.replace(/(food|phl|nyc|la|the|bar|cafe|hotel|shop|store|official)$/i, '');
      const stemNearby = handleStem.length >= 6 && windowKey.includes(handleStem);

      if (!nameNearby && !stemNearby) continue;

      const nameIdx = blob.toLowerCase().indexOf((place.name || '').toLowerCase().replace(/^@/, ''));
      const distance = nameIdx >= 0 ? Math.abs(nameIdx - addr.index) : 9999;
      if (!best || distance < best.distance) {
        best = { addr, distance };
      }
    }

    if (!best) return place;

    const idx = found.indexOf(best.addr);
    if (idx >= 0) used.add(idx);

    console.log(
      `[AI Place Extraction] Attached address "${best.addr.address}" to "${place.name}" from source text`
    );
    return {
      ...place,
      address: best.addr.address,
      confidence: Math.max(place.confidence, 0.8),
    };
  });
}

function applySharedGeoContext(
  places: PlaceExtraction[],
  inputBlob: string
): PlaceExtraction[] {
  if (places.length === 0) return places;

  const cityCounts = new Map<string, { display: string; count: number }>();
  for (const place of places) {
    const city = (place.city || '').trim();
    if (!city) continue;
    const key = city.toLowerCase();
    const prev = cityCounts.get(key);
    cityCounts.set(key, { display: prev?.display || city, count: (prev?.count || 0) + 1 });
  }

  let sharedCity = '';
  let sharedCityCount = 0;
  for (const entry of cityCounts.values()) {
    if (entry.count > sharedCityCount) {
      sharedCity = entry.display;
      sharedCityCount = entry.count;
    }
  }

  const singleArea = looksLikeSingleAreaItinerary(inputBlob, places.length);
  const totalWithCity = [...cityCounts.values()].reduce((sum, e) => sum + e.count, 0);

  if (cityCounts.size === 1) {
    // Only inherit a unique extracted city when this looks like one tour,
    // or when empty places already have street addresses (same-block itinerary).
    const emptiesWithAddress = places.filter(
      (p) => !(p.city || '').trim() && hasStreetAddress(p.address || '')
    ).length;
    if (!singleArea && emptiesWithAddress === 0) {
      sharedCity = '';
    }
  } else if (cityCounts.size > 1) {
    // Multi-city posts: never force a dominant city onto empties unless
    // one city owns a clear majority AND itinerary language is present.
    if (!singleArea || sharedCityCount < Math.ceil(totalWithCity * 0.75)) {
      sharedCity = '';
    }
  } else {
    // No place had a city — only detect from text for single-area itineraries,
    // and only to fill street-address rows (not bare POI names).
    sharedCity = singleArea ? LocationService.detectCityFromText(inputBlob) : '';
  }

  const neighborhoodCounts = new Map<string, { display: string; count: number }>();
  for (const place of places) {
    const neighborhood = (place.neighborhood || '').trim();
    if (!neighborhood) continue;
    const key = neighborhood.toLowerCase();
    const prev = neighborhoodCounts.get(key);
    neighborhoodCounts.set(key, {
      display: prev?.display || neighborhood,
      count: (prev?.count || 0) + 1,
    });
  }

  let sharedNeighborhood = '';
  if (neighborhoodCounts.size === 1 && (singleArea || sharedCity)) {
    sharedNeighborhood = [...neighborhoodCounts.values()][0].display;
  } else if (neighborhoodCounts.size > 1 && singleArea) {
    let bestCount = 0;
    for (const entry of neighborhoodCounts.values()) {
      if (entry.count > bestCount) {
        sharedNeighborhood = entry.display;
        bestCount = entry.count;
      }
    }
    const totalWithHood = [...neighborhoodCounts.values()].reduce((sum, e) => sum + e.count, 0);
    if (bestCount < Math.ceil(totalWithHood * 0.75)) {
      sharedNeighborhood = '';
    }
  }

  if (!sharedCity && !sharedNeighborhood) return places;

  return places.map((place) => {
    const next = { ...place };
    const missingCity = !next.city.trim();
    const missingNeighborhood = !next.neighborhood.trim();
    // When city came only from caption detection (no place had city), only fill
    // rows that already have a street address — leave name-only POIs untouched.
    const allowDetectedCity = cityCounts.size > 0 || hasStreetAddress(next.address || '');

    if (missingCity && sharedCity && allowDetectedCity) {
      next.city = LocationService.cleanCityName(sharedCity);
    }
    if (missingNeighborhood && sharedNeighborhood && (next.city.trim() || sharedCity)) {
      next.neighborhood = sharedNeighborhood;
    }
    return next;
  });
}

function refineExtractedPlaces(
  places: PlaceExtraction[],
  sources: {
    caption?: string;
    ocrTexts?: string[];
    transcript?: string;
    mentions?: string[];
    hashtags?: string[];
  }
): PlaceExtraction[] {
  // Prefer OCR for display-name upgrades; caption/transcript are fallback only.
  // This avoids renaming places from unrelated prose in long talking-head videos.
  const primarySources = (sources.ocrTexts || []).filter(Boolean);
  const fallbackSources = [sources.caption || '', sources.transcript || ''].filter(Boolean);
  const addressSources = [
    sources.caption || '',
    ...(sources.ocrTexts || []),
    sources.transcript || '',
  ].filter(Boolean);

  const withNames = places.map((place) => {
    if (!place.name) return place;
    const fromOcr = resolveDisplayNameFromSources(place.name, primarySources);
    const resolved = fromOcr !== place.name
      ? fromOcr
      : resolveDisplayNameFromSources(place.name, fallbackSources);
    if (resolved === place.name) return place;
    console.log(`[AI Place Extraction] Preferring display name "${resolved}" over handle-like "${place.name}"`);
    return {
      ...place,
      name: resolved,
      confidence: Math.max(place.confidence, 0.8),
    };
  });

  const withAddresses = attachAddressesFromSources(withNames, addressSources);

  const inputBlob = [
    sources.caption || '',
    ...(sources.ocrTexts || []),
    sources.transcript || '',
    ...(sources.mentions || []),
    ...(sources.hashtags || []),
  ].join(' ');

  return applySharedGeoContext(withAddresses, inputBlob);
}

const COMBINED_SYSTEM_PROMPT = `Return JSON: {"places":[...],"analysis":{...}}. PLACES FIRST, then analysis. Analyze only INPUT.

PLACES (extract ALL, max 1000): Scan caption, OCR, transcript start-to-end. Include every distinct named physical place visited/featured/recommended/listed (bonus/last/extra/also). Do NOT trust a stated stop count.

NAME: Prefer OCR/caption venue names over @handles. A business handle directly attached to an offer, venue description, or address identifies a stop; use it without @ only when no display name is available. Never use a promotional headline as a name. Do not treat ordinary people/creator tags as stops. Name must be only the venue's exact display name—not surrounding caption text, promotional copy, labels, hashtags, rankings, or calls to action. If INPUT cannot isolate the display name, skip the place rather than modify or guess it. Skip people, DJs/artists/hosts, dishes, apps, generic unnamed places.

ADDRESS (critical): Extract the exact street line or complete stated Address/location line for each stop whenever present — full ("142 N. 2nd Street") or short ("(140 N. 2nd)", "400 Ranstead", "located at …"). Pair address with the nearest place/handle in the same sentence or parentheses. Never turn a size, height, price, date, or offer into an address; never invent or swap addresses.

GEO: Single-city itinerary → apply shared city/neighborhood to stops that omit city. Multi-city or unclear → keep separate / leave city "". Never invent cities or street numbers absent from INPUT.

category: one of ${PLACE_CATEGORIES.join(', ')}.
confidence: 100=name+street address, 80=named stop with city/area, 60=handle-only/weak.
description: max 12 words from input or "". creator_handle = author_username.

Each place: {"name":"","city":"","neighborhood":"","address":"","category":"","description":"","creator_handle":"","confidence":60}

ANALYSIS (compact): {"summary":"<20 words","primary_category":"","topics":[max 3],"keywords":[max 3],"tone":[max 2],"niche":"","is_promotional":false,"is_sponsored":false,"promotion_type":"","call_to_actions":[],"offers":[],"primary_audience":"","audience_interests":[max 2],"geographic_focus":[max 2],"audience_intent":"","audience_confidence":0}. Use ""/[]/false when unsupported. Do NOT invent. JSON only, no markdown.`;

const COMBINED_RESPONSE_FORMAT: any = {
  type: 'json_schema',
  json_schema: {
    name: 'content_analysis_with_places',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        places: {
          type: 'array',
          maxItems: 1000,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' }, city: { type: 'string' }, neighborhood: { type: 'string' }, address: { type: 'string' },
              category: { type: 'string', enum: [...PLACE_CATEGORIES] }, description: { type: 'string' }, creator_handle: { type: 'string' },
              confidence: { type: 'integer', enum: [...PLACE_CONFIDENCE_CODES] },
            },
            required: ['name', 'city', 'neighborhood', 'address', 'category', 'description', 'creator_handle', 'confidence'],
            additionalProperties: false,
          },
        },
        analysis: {
          type: 'object',
          properties: {
            summary: { type: 'string' }, primary_category: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } },
            tone: { type: 'array', items: { type: 'string' } }, niche: { type: 'string' },
            is_promotional: { type: 'boolean' }, is_sponsored: { type: 'boolean' }, promotion_type: { type: 'string' },
            call_to_actions: { type: 'array', items: { type: 'string' } }, offers: { type: 'array', items: { type: 'string' } },
            primary_audience: { type: 'string' }, audience_interests: { type: 'array', items: { type: 'string' } }, geographic_focus: { type: 'array', items: { type: 'string' } },
            audience_intent: { type: 'string' }, audience_confidence: { type: 'number' },
          },
          required: ['summary', 'primary_category', 'topics', 'keywords', 'tone', 'niche', 'is_promotional', 'is_sponsored', 'promotion_type', 'call_to_actions', 'offers', 'primary_audience', 'audience_interests', 'geographic_focus', 'audience_intent', 'audience_confidence'],
          additionalProperties: false,
        },
      },
      required: ['places', 'analysis'],
      additionalProperties: false,
    },
  },
};

export class AiEnrichmentService {
  static formatCondensedCaption(caption: string | null | undefined, maxLen = 1000): string {
    if (!caption) return '';
    const trimmed = caption.trim();
    if (trimmed.length <= maxLen) return trimmed;

    const lines = trimmed.split('\n');
    const locationRegex = /(📍|📌|🗺️|located|location|address|st\b|street|ave\b|avenue|blvd|rd\b|road|dr\b|drive|way\b|unit|suite|#)/i;

    const importantLines: string[] = [];
    let charCount = 0;

    for (const line of lines) {
      const isLoc = locationRegex.test(line);
      if (charCount < 400 || isLoc) {
        importantLines.push(line);
        charCount += line.length + 1;
      }
    }

    return importantLines.join('\n').substring(0, maxLen);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. Place extraction (for map feature)
  // ──────────────────────────────────────────────────────────────────────
  static async extractPlace(
    content: SocialContent,
    transcript: string,
    ocrTexts: string[]
  ): Promise<PlaceExtraction[]> {
    const condensedInput = {
      platform: content.platform,
      caption: content.caption ? content.caption.trim() : '',
      author_username: content.authorUsername,
      mentions: content.mentions || [],
      tagged_users: (content.taggedUsers || []).map(u => typeof u === 'string' ? u : u.username),
      ocr_texts: ocrTexts || [],
      audio_transcript: transcript ? transcript.trim() : null,
    };

    const responseFormat: any = {
      type: 'json_schema',
      json_schema: {
        name: 'place_extraction_list',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            places: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  city: { type: 'string' },
                  neighborhood: { type: 'string' },
                  address: { type: 'string' },
                  category: {
                    type: 'string',
                    enum: [...PLACE_CATEGORIES],
                    description: 'One fixed map category',
                  },
                  description: { type: 'string' },
                  creator_handle: { type: 'string' },
                  confidence: {
                    type: 'integer',
                    enum: [...PLACE_CONFIDENCE_CODES],
                    description: 'Confidence percent: 100, 80, or 60',
                  },
                },
                required: ['name', 'city', 'neighborhood', 'address', 'category', 'description', 'creator_handle', 'confidence'],
                additionalProperties: false,
              },
            },
          },
          required: ['places'],
          additionalProperties: false,
        },
      },
    };

    return executeAICall('chat', async ({ client, model, isGroq }) => {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: PLACE_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(condensedInput) },
        ],
        response_format: isGroq ? { type: 'json_object' } : responseFormat,
      });

      const raw = response.choices[0].message.content;
      if (!raw) return [];
      const places = parsePlaceResponse(raw, content.authorUsername);
      return refineExtractedPlaces(places, {
        caption: content.caption,
        ocrTexts: ocrTexts || [],
        transcript,
        mentions: content.mentions,
        hashtags: content.hashtags,
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. Full analysis
  // ──────────────────────────────────────────────────────────────────────
  static compressOcrTexts(texts: string[]): string[] {
    if (!texts || texts.length === 0) return [];

    let compressed = texts.map(text => {
      const words = text.split(/\s+/);
      return removeStopwords(words, eng).join(' ').trim();
    }).filter(t => t.length > 2);

    const unique: string[] = [];
    for (const text of compressed) {
      if (unique.length === 0) {
        unique.push(text);
        continue;
      }

      const bestMatch = stringSimilarity.findBestMatch(text.toLowerCase(), unique.map(u => u.toLowerCase()));
      if (bestMatch.bestMatch.rating < 0.85) {
        unique.push(text);
      }
    }

    return unique;
  }

  static extractTranscriptEntities(transcript: string): string {
    if (!transcript || transcript.trim().length === 0) return '';
    const doc = nlp(transcript);
    const places = doc.places().out('array');
    const nouns = doc.nouns().out('array');
    const entities = Array.from(new Set([...places, ...nouns]))
      .filter(w => w.length > 3)
      .slice(0, 30)
      .join(', ');
    return entities;
  }

  static async analyzeContent(
    content: SocialContent,
    rawApifyData: any,
    transcript: string,
    gptOcrTexts: string[],
    apifyOcrTexts: string[]
  ): Promise<{ analysis: AiAnalysisResult; places: PlaceExtraction[] } | null> {
    const ocrTexts = Array.from(new Set([...gptOcrTexts, ...apifyOcrTexts].map(text => text.trim()).filter(Boolean)));
    const caption = content.caption ? content.caption.trim() : '';
    const trimmedTranscript = transcript ? transcript.trim() : '';
    const taggedUsers = (content.taggedUsers || []).map(u => typeof u === 'string' ? u : u.username).filter(Boolean);

    const condensedInput: Record<string, unknown> = {
      platform: content.platform,
      author_username: content.authorUsername,
    };
    if (caption) condensedInput.caption = caption;
    if (content.contentType) condensedInput.content_type = content.contentType;
    if ((content.hashtags || []).length > 0) condensedInput.hashtags = content.hashtags;
    if ((content.mentions || []).length > 0) condensedInput.mentions = content.mentions;
    if (taggedUsers.length > 0) condensedInput.tagged_users = taggedUsers;
    // OCR lines are source evidence. Keep every deduplicated line so later
    // frames in a list-style video cannot lose their venue names.
    if (ocrTexts.length > 0) condensedInput.ocr_texts = ocrTexts;
    if (trimmedTranscript) condensedInput.audio_transcript = trimmedTranscript;

    const ocrAvailable = gptOcrTexts.length > 0 || apifyOcrTexts.length > 0;
    const transcriptAvailable = !!transcript && transcript.trim().length > 0;

    const userMessage = JSON.stringify(condensedInput);

    const durationSec = content.videoDuration ?? 0;
    let maxTokens: number;
    if (durationSec <= 60) {
      maxTokens = 1500;
    } else if (durationSec <= 90) {
      maxTokens = 2500;
    } else if (durationSec <= 120) {
      maxTokens = 2500;
    } else {
      maxTokens = 3500;
    }

    return executeAICall('chat', async ({ client, model, isGroq }) => {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: COMBINED_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        response_format: isGroq ? { type: 'json_object' } : COMBINED_RESPONSE_FORMAT,
        max_tokens: maxTokens,
      });
      const raw = response.choices[0].message.content || '{}';

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        throw new Error('[AI Analysis] Model returned invalid JSON.');
      }
      if (!isRecord(parsedJson)) {
        throw new Error('[AI Analysis] Model response was not a JSON object.');
      }
      const parsed = isRecord(parsedJson.analysis) ? parsedJson.analysis as any : {};
      let places: PlaceExtraction[] = [];
      try {
        places = refineExtractedPlaces(
          parsePlaceResponse(raw, content.authorUsername),
          {
            caption: content.caption,
            ocrTexts,
            transcript: trimmedTranscript,
            mentions: content.mentions,
            hashtags: content.hashtags,
          }
        );
      } catch (placeError) {
        console.warn('[AI Place Extraction] Combined response had no usable places:', placeError);
      }

      const analysis: AiAnalysisResult = {
        platform: parsed.platform || content.platform,
        content: {
          content_id: content.contentId,
          content_type: content.contentType,
          url: rawApifyData.url || rawApifyData.webVideoUrl || '',
          video_url: content.videoUrl || null,
          thumbnail_url: content.displayUrl || null,
          published_at: content.publishedAt,
          duration_seconds: content.videoDuration,
          dimensions: content.dimensions
            ? { ...content.dimensions, orientation: content.dimensions.height > content.dimensions.width ? 'vertical' : 'horizontal' }
            : null,
          summary: parsed.summary || '',
          primary_category: parsed.primary_category || '',
          secondary_categories: [],
          topics: parsed.topics || [],
          keywords: parsed.keywords || [],
        },
        creator: {
          id: rawApifyData.ownerId || rawApifyData.authorMeta?.id || '',
          username: content.authorUsername,
          full_name: content.authorFullName,
          profile_url: parsed.creator?.profile_url || null,
          verified: parsed.creator?.verified || null,
        },
        caption_analysis: {
          original_caption: content.caption,
          summary: parsed.summary || '',
          keywords: parsed.keywords || [],
          hashtags: content.hashtags,
          mentions: content.mentions,
          call_to_actions: parsed.call_to_actions || [],
        },
        entities: { brands: [], products: [], companies: [], restaurants: [], services: [], people: [], locations: [], websites: [] },
        visual_analysis: parsed.visual_analysis || { visible_text: [], products_visible: [], brands_visible: [], people_visible: [], locations_visible: [], objects_visible: [], logos_visible: [] },
        audio_analysis: parsed.audio_analysis || {
          artist: content.musicInfo?.artist_name || null,
          song_name: content.musicInfo?.song_name || null,
          audio_id: content.musicInfo?.audio_id || null,
          uses_original_audio: content.musicInfo?.uses_original_audio || null,
          transcript: transcript || null,
          spoken_information: [],
        },
        promotion: {
          is_promotional: parsed.is_promotional ?? false,
          is_sponsored: parsed.is_sponsored ?? false,
          is_paid_partnership: content.paidPartnership,
          promotion_type: parsed.promotion_type || null,
          promoted_entities: [],
          offers: parsed.offers || [],
          discounts: [],
          call_to_actions: parsed.call_to_actions || [],
        },
        audience: {
          primary_audience: parsed.primary_audience || '',
          interests: parsed.audience_interests || [],
          geographic_focus: parsed.geographic_focus || [],
          intent: parsed.audience_intent || '',
          confidence: parsed.audience_confidence || 0,
        },
        content_style: {
          tone: parsed.tone || [],
          style: [],
          format: '',
        },
        engagement: parsed.engagement || {
          likes: content.metrics.likes,
          comments: content.metrics.comments,
          shares: content.metrics.shares,
          saves: content.metrics.saves,
          views: content.metrics.views,
          plays: content.metrics.plays,
          reach: null,
          impressions: null,
          engagement_rate: null,
          engagement_rate_formula: null,
        },
        hashtags: parsed.hashtags || { all: content.hashtags, brand: [], product: [], industry: [], location: [], campaign: [], topic: [], generic: [] },
        campaign_insights: parsed.campaign_insights || { relevant_industries: [], relevant_brand_categories: [], relevant_product_categories: [], relevant_audiences: [], relevant_locations: [], potential_campaign_themes: [], potential_collaboration_categories: [], campaign_suitability: '', reasoning: '' },
        influencer_analysis: { niche: parsed.niche || '', sub_niches: [], content_strengths: [], potential_collaboration_types: [], potential_brand_categories: [] },
        data_quality: parsed.data_quality || {
          available_fields: Object.keys(condensedInput).filter(k => (condensedInput as any)[k] != null),
        },
        extracted_information: parsed.extracted_information || [],
      };

      return { analysis, places };
    });
  }
}
