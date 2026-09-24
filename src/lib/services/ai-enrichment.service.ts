import { executeAICall, supportsTemperature } from './ai-client';
import { LocationService } from './location.service';
import { plog } from './pipeline-log';
import {
  BASE_CATEGORIES, GENERIC_NAMES, buildEvidence, formatEvidenceForPrompt, mergeSameEntities, resolveHiddenGem,
  sanitizeCandidateLocation, scoreAndFilterCandidates,
  type BaseCategory, type EvidenceBundle, type MediaEvidenceInput, type RawPlaceCandidate,
} from './place-evidence.service';
import type { SocialContent, AiAnalysisResult, PlaceExtraction, PlaceCategory } from '../types/social';

const PLACE_CATEGORIES = [
  'RESTAURANTS', 'COFFEE', 'TRAVEL', 'ADVENTURE', 'NATURE', 'CITY',
  'SHOPPING', 'NIGHTLIFE', 'CULTURE', 'HIDDEN GEMS', 'BARS',
] as const;

const MENTION_TYPES = ['explicit', 'handle', 'indirect'] as const;
const ROLES = ['featured', 'recommended', 'mentioned_only', 'background'] as const;

/**
 * Keep the requested completion below the 20k TPM tier once the evidence
 * prompt is included. A larger reservation is rejected before the model can
 * return any data (for example, 8k prompt + 16k completion = 24k TPM).
 * Ten thousand tokens remains ample for a structured place list; a truncated
 * result uses the existing grounded recovery pass.
 */
const MAX_OUTPUT_TOKENS = 20_000;
const RECOVERY_OUTPUT_TOKENS = 20_000;

function analysisFallbackWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|rate[_ -]?limit|quota|tokens?\s+per\s+min|tpm)/i.test(message)
    ? 'AI providers are rate-limited. The request was completed with verified scraped data, OCR, and transcript; no unverified AI place candidates were added.'
    : 'AI analysis is temporarily unavailable. The request was completed with verified scraped data, OCR, and transcript; no unverified AI place candidates were added.';
}

// ──────────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────────

const PLACE_RULES = `You extract real-world places from ONE Instagram/TikTok post. Use ONLY the numbered EVIDENCE lines — never your own knowledge of places, cities, or addresses.

EVIDENCE SOURCES (id prefix)
C caption · L platform location tag · A tagged / collab / mentioned account with its display name · O on-screen text from OCR (may contain letter errors; t = seconds) · V on-screen text from high-accuracy OCR · S speech transcript (seconds) · H hashtags · K comments (creator's own comments are marked) · X image description · B creator bio (context only, never enough on its own).
The place can appear in only ONE source. Captions are often silent while the venue name is only on screen, only spoken, only a tagged account, or only the location tag. Read every line before answering.

WHAT IS A PLACE
A specific, named, physical location someone can visit: restaurant, cafe, bar, club, shop, market, hotel, museum, gallery, park, beach, trail, viewpoint, landmark, street, or a town/island that is itself the destination.
Not places: people, the creator, DJs/artists, the audio track, brands or products with no specific location (a drink brand, an app), dishes, events without a venue, generic phrases ("this cafe", "the best pizza spot").
A city, state, or country that only says WHERE the other places are is location context: put it in those places' "city" field instead of returning it as a place.
Posts often contain several places (lists, itineraries, guides, "3 spots in…", "bonus stop"); guides with 20–40 places are normal. Return every one separately — never stop early or summarise. Do not trust a stated count; return what the evidence shows. Every 📍 line is a candidate: return it unless it is clearly not a place.

ROLE (return every candidate; the system keeps only featured and recommended)
featured = shown, visited, reviewed · recommended = suggested but not shown · mentioned_only = comparison, joke, "better than X", passing reference · background = visible but not the subject (a logo on a cup, a passing sign, a photo credit).
Entries of a guide, itinerary or list ("Day 2 - Evening plans @brasseriecognac", "SHOPS: Vowels, PHOS") are featured or recommended — never mentioned_only.

NAME
- Copy the venue's display name as written in the evidence. Fix an OCR letter error only when another line confirms the spelling (O3 "CAFE LUMIFRE" + A1 "Café Lumière" → "Café Lumière").
- If an account identifies the venue, prefer its display name from the A line ("Joe's Pizza" for @joespizzanyc). With no display name anywhere, use the handle without @ and set mention_type "handle".
- Never use a headline, slogan, ranking ("#1"), price, hashtag, or caption sentence as a name.
- mention_type "indirect": the creator clearly describes ONE specific place without naming it ("the horror bookstore on Frankford Ave"). Set name "" and search_query to words copied from the evidence plus the city ("horror bookstore Frankford Ave Philadelphia"). Otherwise search_query "".
- mention_type "explicit" for every normally named place.

LOCATION
- city / neighborhood / address only when the evidence states them: a line, the location tag, or a location hashtag (#phillyeats → Philadelphia).
- One-city post: when the location tag, caption, or hashtags name a single city and nothing contradicts it, that city applies to every place.
- address: copy the street line exactly ("140 N. 2nd", "209 Chestnut St", "(400 Ranstead)") and pair it with the place in the same line, the same list item, or the same moment. Never invent, complete, or move an address. Sizes, prices, dates, and counts are not addresses.
- Same moment: on-screen text and speech within about 3 seconds of each other describe the same scene. Use this to pair a name on screen with a city or address spoken aloud, and the reverse.
- "📍" marks a location marker. Creators use many styles (📍 📌 🗺️ pins, map-pin icons, location stickers, "Location:"/"Address:" labels); all are shown as "📍". Everything on one marker belongs to the same place: "📍 Buvette · 42 Grove St · West Village" gives name, address and neighbourhood. A marker holding only an address or area locates the venue shown or named in the same scene.
- A short on-screen label that appears only for one scene (often a location marker, e.g. "📍 Buvette" or just "Buvette") names the place shown in that scene, while text repeated on every frame is the post's title.
- Map and area-guide labels are destinations, not scenery: when a post shows several named neighbourhoods, towns, parks, or areas on a map/list, return each as category CITY with role featured or recommended. This applies even when OCR splits a label across adjacent lines ("Ridge" + "Wood" = "Ridgewood").
- Text that is physically inside the scene — posters, artwork, menus, plates, product labels, film titles — is role "background", not a venue, unless it is the storefront sign of the place being visited. When the post labels its places with pin stickers or overlays, only those labels are places.

EVIDENCE IDS (required)
name_evidence: ids of the lines that contain the name or identify the venue. location_evidence: ids supporting city / neighborhood / address. Cite only ids present in EVIDENCE.

CATEGORY
base_category = what the place IS: RESTAURANTS (restaurants, food spots, bakeries, street food) · COFFEE (cafes, coffee, tea) · BARS (bars, pubs, cocktail/wine bars, breweries) · NIGHTLIFE (clubs, live music, late-night venues) · SHOPPING (shops, markets, malls, boutiques) · CULTURE (museums, galleries, theatres, historic or religious sites) · NATURE (parks, beaches, lakes, mountains, gardens, trails) · ADVENTURE (activities: tours, diving, climbing, theme parks, water sports) · TRAVEL (hotels, resorts, stays; towns/islands visited as a trip) · CITY (streets, squares, neighbourhoods, city viewpoints, urban landmarks).
category = base_category, or "HIDDEN GEMS" only when the evidence explicitly calls the place a hidden gem, secret, underrated, hole-in-the-wall, or locals-only spot.
description: at most 12 words taken from the evidence, or "".`;

const ANALYSIS_RULES = `ANALYSIS (compact, from evidence only): {"summary":"<20 words","primary_category":"","topics":[max 3],"keywords":[max 3],"tone":[max 2],"niche":"","is_promotional":false,"is_sponsored":false,"promotion_type":"","call_to_actions":[],"offers":[],"primary_audience":"","audience_interests":[max 2],"geographic_focus":[max 2],"audience_intent":"","audience_confidence":0}. Use ""/[]/false when unsupported.`;

const COMBINED_SYSTEM_PROMPT = `${PLACE_RULES}

${ANALYSIS_RULES}

Return one JSON object: {"places":[...],"analysis":{...}}. No markdown.`;

const PLACES_ONLY_SYSTEM_PROMPT = `${PLACE_RULES}

Return one JSON object: {"places":[...]}. No markdown.`;

const PLACE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    mention_type: { type: 'string', enum: [...MENTION_TYPES] },
    role: { type: 'string', enum: [...ROLES] },
    name_evidence: { type: 'array', items: { type: 'string' } },
    location_evidence: { type: 'array', items: { type: 'string' } },
    city: { type: 'string' },
    neighborhood: { type: 'string' },
    address: { type: 'string' },
    base_category: { type: 'string', enum: [...BASE_CATEGORIES] },
    category: { type: 'string', enum: [...PLACE_CATEGORIES] },
    description: { type: 'string' },
    search_query: { type: 'string' },
  },
  required: ['name', 'mention_type', 'role', 'name_evidence', 'location_evidence', 'city', 'neighborhood', 'address', 'base_category', 'category', 'description', 'search_query'],
  additionalProperties: false,
};

const ANALYSIS_SCHEMA = {
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
};

function responseFormat(includeAnalysis: boolean): any {
  return {
    type: 'json_schema',
    json_schema: {
      name: includeAnalysis ? 'places_with_analysis' : 'places',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          places: { type: 'array', items: PLACE_ITEM_SCHEMA },
          ...(includeAnalysis ? { analysis: ANALYSIS_SCHEMA } : {}),
        },
        required: includeAnalysis ? ['places', 'analysis'] : ['places'],
        additionalProperties: false,
      },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Response parsing (lenient: Groq JSON mode is not schema-enforced)
// ──────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean) : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = str(value) as T;
  return allowed.includes(candidate) ? candidate : fallback;
}

export function parseCandidates(raw: string): RawPlaceCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('[AI Place Extraction] Model returned invalid JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.places)) {
    throw new Error('[AI Place Extraction] Model response did not match the required {"places": []} shape.');
  }
  const candidates: RawPlaceCandidate[] = [];
  for (const value of parsed.places) {
    if (!isRecord(value)) continue;
    const category = str(value.category) as PlaceCategory;
    const baseRaw = str(value.base_category) as BaseCategory;
    const base = BASE_CATEGORIES.includes(baseRaw)
      ? baseRaw
      : (BASE_CATEGORIES.includes(category as BaseCategory) ? category as BaseCategory : null);
    if (!base) continue;
    // Trademark signs and emoji come from account display names ("L'industrie Pizzeria ™️").
    const name = str(value.name)
      .replace(/^@/, '')
      .replace(/[\u2122\u00AE\u00A9]\uFE0F?/g, '')
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name.includes('#')) continue;
    candidates.push({
      name,
      mention_type: oneOf(value.mention_type, MENTION_TYPES, 'explicit'),
      role: oneOf(value.role, ROLES, 'featured'),
      name_evidence: strList(value.name_evidence),
      location_evidence: strList(value.location_evidence),
      city: str(value.city),
      neighborhood: str(value.neighborhood),
      address: str(value.address),
      base_category: base,
      category: PLACE_CATEGORIES.includes(category as any) ? category : base,
      description: str(value.description).split(/\s+/).slice(0, 16).join(' '),
      search_query: str(value.search_query),
    });
  }
  return candidates;
}

// ──────────────────────────────────────────────────────────────────────
// Source-text refinement (deterministic, grounded by construction)
// ──────────────────────────────────────────────────────────────────────

function collapseAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Handle-shaped names only: "@joespizzanyc", "gaslamphotel", "cafe_lumiere".
 * A capitalised single word ("Tatte", "Kasama") is a real display name and
 * must never be replaced by a longer line that merely contains it.
 */
function looksLikeHandleName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!/^@?[a-z0-9._]+$/i.test(trimmed)) return false;
  return trimmed.startsWith('@') || /[._\d]/.test(trimmed) || trimmed === trimmed.toLowerCase();
}

/** Prefer OCR/caption display names over bare @handles when they clearly refer to the same venue. */
function resolveDisplayNameFromSources(name: string, sources: string[]): string {
  if (!looksLikeHandleName(name) || sources.length === 0) return name;

  const handleKey = collapseAlnum(name.replace(/^@/, ''));
  if (handleKey.length < 4) return name;

  const candidates = new Set<string>();
  for (const source of sources) {
    for (const part of source.split(/[\n|;•·]+/)) {
      // Drop list numbering ("3. Kasama") before comparing.
      const trimmed = part.trim().replace(/^\d{1,2}[.)]\s*/, '');
      if (trimmed.length >= 4 && /\s/.test(trimmed) && trimmed.length <= 80 && !trimmed.includes('@')) {
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
    // A display name is about as long as the handle ("The Gas Lamp Hotel" vs
    // "gaslamphotel"); a sentence that happens to contain it is not a name.
    if (candidateKey.length > handleKey.length + 6) continue;
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
  if (!isPlausibleStreetAddress(value)) return false;
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
  // Caption prose such as "Founded in 2017 by two brothers" is sometimes
  // returned by a model as `2017 by`. A four-digit building number is valid
  // only when it is followed by a street-shaped name, not founding prose.
  if (/^\d{4}\s+(?:by|in|from|for|with|was|were|is|are|founded|established|opened|created|built|since|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(normalized)) {
    return false;
  }
  // Avoid converting list copy such as "5 cozy restaurants" into the
  // fabricated address "5 cozy Street".
  if (/^\d{1,6}\s+(?:cozy|best|top|great|favorite|popular|new|nice|amazing|restaurants?|cafes?|bars?|places?|spots?|stops?|things?|days?|hours?|minutes?|mins?|people|dollars?|years?)\b/i.test(normalized)) {
    return false;
  }
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
    if (hasStreetAddress(current) && isPlausibleStreetAddress(current)) {
      // Already has a usable street address; still expand short forms.
      return { ...place, address: expandShortStreetAddress(current) };
    }
    const placeWithoutInvalidAddress = current ? { ...place, address: '' } : place;

    const nameKey = collapseAlnum(place.name || '');
    if (!nameKey) return placeWithoutInvalidAddress;

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

    if (!best) return placeWithoutInvalidAddress;

    const idx = found.indexOf(best.addr);
    if (idx >= 0) used.add(idx);

    plog('candidates', 'Address attached from source text', { place: place.name, address: best.addr.address });
    return { ...placeWithoutInvalidAddress, address: best.addr.address };
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

function refineExtractedPlaces(places: PlaceExtraction[], bundle: EvidenceBundle): PlaceExtraction[] {
  const textOf = (sources: string[]) => bundle.items.filter((item) => sources.includes(item.source)).map((item) => item.text);
  // Prefer on-screen text for display-name upgrades; caption/speech are fallback only.
  // This avoids renaming places from unrelated prose in long talking-head videos.
  const primarySources = textOf(['ocr', 'vision_ocr']);
  const caption = textOf(['caption']).join('\n');
  const speech = textOf(['speech']).join(' ');
  const fallbackSources = [caption, speech].filter(Boolean);
  const addressSources = [caption, ...textOf(['ocr', 'vision_ocr', 'comment_creator']), speech].filter(Boolean);

  const withNames = places.map((place) => {
    if (!place.name) return place;
    const fromOcr = resolveDisplayNameFromSources(place.name, primarySources);
    const resolved = fromOcr !== place.name ? fromOcr : resolveDisplayNameFromSources(place.name, fallbackSources);
    if (resolved === place.name) return place;
    plog('candidates', 'Display name preferred over handle', { handle: place.name, name: resolved });
    return { ...place, name: resolved };
  });

  const withAddresses = attachAddressesFromSources(withNames, addressSources);
  const inputBlob = bundle.items.map((item) => item.text).join(' ');
  return applySharedGeoContext(withAddresses, inputBlob);
}

/**
 * Distinct street addresses in the evidence, keyed by number + street name so
 * the same address read twice ("1207 Nostrand" by local OCR, "1207 Nostrand
 * Ave" by vision) counts once.
 */
function distinctSourceAddressCount(sources: string[]): number {
  const keys = findStreetAddressesInText(sources.filter(Boolean).join('\n')).map((entry) => {
    const match = entry.address.toLowerCase().match(/^(\d+)\s+(?:(?:north|south|east|west)\s+)?([a-z0-9]+)/);
    return match ? `${match[1]} ${match[2]}` : collapseAlnum(entry.address);
  });
  return new Set(keys).size;
}

// ──────────────────────────────────────────────────────────────────────
// Candidate → final place pipeline
// ──────────────────────────────────────────────────────────────────────

export interface PlaceExtractionOutcome {
  places: PlaceExtraction[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Deterministic post-processing of model candidates:
 * ground location fields → refine from source text → verify names against
 * evidence and score → HIDDEN GEMS check → merge duplicates → resolve
 * indirect mentions (Google, single-result only).
 */
export async function finalizeCandidates(
  candidates: RawPlaceCandidate[],
  bundle: EvidenceBundle,
  authorUsername: string,
  options: { resolveIndirect?: boolean } = {}
): Promise<PlaceExtractionOutcome> {
  const asPlaces: PlaceExtraction[] = candidates.map((candidate) => {
    const located = sanitizeCandidateLocation({
      city: LocationService.cleanCityName(candidate.city),
      neighborhood: candidate.neighborhood,
      address: candidate.address,
    }, bundle);
    return {
      name: candidate.name || null,
      city: located.city,
      neighborhood: located.neighborhood,
      address: located.address,
      category: candidate.category,
      base_category: candidate.base_category,
      description: candidate.description,
      creator_handle: authorUsername,
      confidence: 0,
      mention_type: candidate.mention_type,
      role: candidate.role === 'featured' || candidate.role === 'recommended' ? candidate.role : undefined,
      search_query: candidate.search_query,
    };
  });
  const candidateRoles = candidates.map((candidate) => candidate.role);
  plog('candidates', `Model returned ${candidates.length} candidate(s)`, {
    candidates: candidates.map((candidate) => ({
      name: candidate.name || `(indirect: ${candidate.search_query})`,
      role: candidate.role,
      mention: candidate.mention_type,
      city: candidate.city,
      address: candidate.address,
      category: candidate.category,
      nameEvidence: candidate.name_evidence,
    })),
  });

  const refined = refineExtractedPlaces(asPlaces, bundle).map((place, index) => ({
    ...place,
    ...sanitizeCandidateLocation(place, bundle),
    // The model's raw role, so background/mentioned_only are rejected with a reason.
    candidateRole: candidateRoles[index],
  }));

  const { places: scored, rejected } = scoreAndFilterCandidates(refined, bundle);
  for (const item of rejected) plog('candidates', `Rejected "${item.name}"`, { reason: item.reason });

  const categorized = scored.map((place) => ({ ...place, category: resolveHiddenGem(place, bundle) }));
  let merged = mergeSameEntities(categorized, bundle);

  if (options.resolveIndirect !== false) {
    const resolved: PlaceExtraction[] = [];
    for (const place of merged) {
      if (place.mention_type !== 'indirect' || place.name) {
        resolved.push(place);
        continue;
      }
      const match = await LocationService.findUniquePlace(place.search_query || '', place.city).catch(() => null);
      if (!match) {
        rejected.push({ name: place.search_query || '(indirect)', reason: 'indirect mention has no unique Google match' });
        continue;
      }
      resolved.push({
        ...place,
        name: match.name,
        city: place.city || match.city || '',
        explanation: `${place.explanation?.replace(/\.$/, '')}; Google Maps returned a single match for "${place.search_query}".`,
      });
    }
    merged = mergeSameEntities(resolved, bundle);
  }

  for (const place of merged) {
    plog('candidates', `Accepted "${place.name}"`, {
      score: place.confidence,
      category: place.category,
      city: place.city,
      neighborhood: place.neighborhood,
      address: place.address,
      evidence: place.evidence_ids,
      why: place.explanation,
    });
  }
  return { places: merged, rejected };
}

async function callExtractionModel(
  bundle: EvidenceBundle,
  includeAnalysis: boolean,
  maxTokens: number,
  note?: string
): Promise<{ raw: string; truncated: boolean }> {
  const userMessage = note ? `${note}\n\n${formatEvidenceForPrompt(bundle)}` : formatEvidenceForPrompt(bundle);
  return executeAICall('chat', async ({ client, model, isGroq }, reportUsage) => {
    const response = await client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0 } : {}),
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: includeAnalysis ? COMBINED_SYSTEM_PROMPT : PLACES_ONLY_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: isGroq ? { type: 'json_object' } : responseFormat(includeAnalysis),
    });
    const choice = response.choices[0];
    reportUsage({
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      requestSummary: { includeAnalysis, maxCompletionTokens: maxTokens, promptChars: userMessage.length },
      resultSummary: { finishReason: choice?.finish_reason || null },
    });
    plog('model', includeAnalysis ? 'Extraction + analysis call' : 'Places-only call', {
      provider: isGroq ? 'groq' : 'openai',
      model,
      promptChars: userMessage.length,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      finishReason: choice?.finish_reason,
    }, choice?.finish_reason === 'length' ? 'warn' : 'info');
    return { raw: choice?.message?.content || '{}', truncated: choice?.finish_reason === 'length' };
  });
}


function generateFallbackCandidates(content: SocialContent, bundle: EvidenceBundle): RawPlaceCandidate[] {
  const candidates: RawPlaceCandidate[] = [];
  const addedNames = new Set<string>();

  const rawLocTag = typeof content.locationTag === 'string' ? content.locationTag : content.locationTag?.name || '';
  if (rawLocTag && rawLocTag.trim()) {
    const name = rawLocTag.trim();
    if (!GENERIC_NAMES.has(name.toLowerCase())) {
      const city = LocationService.detectCityFromText(name) || LocationService.detectCityFromText(content.caption || '') || '';
      candidates.push({
        name,
        mention_type: 'explicit',
        role: 'featured',
        name_evidence: ['L1'],
        location_evidence: ['L1'],
        city,
        neighborhood: '',
        address: '',
        base_category: 'CITY',
        category: 'CITY',
        description: 'Platform location tag',
        search_query: '',
      });
      addedNames.add(name.toLowerCase());
    }
  }

  if (Array.isArray(content.taggedUsers)) {
    for (const user of content.taggedUsers) {
      if (!user) continue;
      const displayName = (user.full_name || user.username || '').replace(/^@/, '').trim();
      if (displayName && displayName.length >= 3 && !GENERIC_NAMES.has(displayName.toLowerCase()) && !addedNames.has(displayName.toLowerCase())) {
        candidates.push({
          name: displayName,
          mention_type: user.full_name ? 'explicit' : 'handle',
          role: 'featured',
          name_evidence: ['A1'],
          location_evidence: [],
          city: LocationService.detectCityFromText(content.caption || '') || '',
          neighborhood: '',
          address: '',
          base_category: 'RESTAURANTS',
          category: 'RESTAURANTS',
          description: 'Tagged venue account',
          search_query: '',
        });
        addedNames.add(displayName.toLowerCase());
      }
    }
  }

  for (const item of bundle.items) {
    if (/^📍/u.test(item.text)) {
      const cleaned = item.text.replace(/^📍\s*/u, '').trim();
      const parts = cleaned.split(/·|\n|\|/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) {
        const name = parts[0];
        if (name && name.length >= 3 && !GENERIC_NAMES.has(name.toLowerCase()) && !addedNames.has(name.toLowerCase())) {
          const address = parts.find((p) => /\d/.test(p) && isPlausibleStreetAddress(p)) || '';
          const city = LocationService.detectCityFromText(cleaned) || LocationService.detectCityFromText(content.caption || '') || '';
          candidates.push({
            name,
            mention_type: 'explicit',
            role: 'featured',
            name_evidence: [item.id],
            location_evidence: [item.id],
            city,
            neighborhood: '',
            address,
            base_category: 'RESTAURANTS',
            category: 'RESTAURANTS',
            description: 'On-screen location marker',
            search_query: '',
          });
          addedNames.add(name.toLowerCase());
        }
      }
    }
  }

  return candidates;
}

const VISUAL_GUIDE_RE = /\b(?:dining|restaurants?|caf(?:e|é)s?|coffee|bars?|food|spots?|places|guide|itinerary|top)\b/i;

function visualTextKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function guideCategory(text: string): BaseCategory | null {
  if (/\b(?:dining|restaurants?|food)\b/i.test(text)) return 'RESTAURANTS';
  if (/\b(?:caf(?:e|é)s?|coffee|tea)\b/i.test(text)) return 'COFFEE';
  if (/\b(?:bars?|pubs?|cocktails?|wine)\b/i.test(text)) return 'BARS';
  if (/\b(?:shops?|stores?|shopping|markets?)\b/i.test(text)) return 'SHOPPING';
  return null;
}

/**
 * Recover cards from a clearly labelled visual guide without asking the model
 * to rediscover text that Vision has already transcribed. It is deliberately
 * limited to guides whose visible title establishes the place category.
 */
function generateVisualGuideCandidates(
  content: SocialContent,
  media: MediaEvidenceInput,
  bundle: EvidenceBundle
): RawPlaceCandidate[] {
  const frames = media.visionFrames || [];
  if (!['video', 'reel'].includes(content.contentType) || frames.length < 2) return [];

  const allText = [content.caption || '', ...frames.flatMap((frame) => frame.texts || [])].join('\n');
  const baseCategory = guideCategory(allText);
  if (!baseCategory || !VISUAL_GUIDE_RE.test(allText)) return [];

  const appearances = new Map<string, Set<number>>();
  for (const frame of frames) {
    for (const text of new Set((frame.texts || []).map((line) => line.trim()).filter(Boolean))) {
      const key = visualTextKey(text);
      if (key) appearances.set(key, new Set([...(appearances.get(key) || []), frame.frameIndex]));
    }
  }
  const repeatedTitleKeys = new Set(
    [...appearances.entries()]
      .filter(([, seen]) => seen.size >= Math.max(3, Math.ceil(frames.length * 0.6)))
      .map(([key]) => key)
  );
  const city = LocationService.detectCityFromText(allText) || '';
  const candidates: RawPlaceCandidate[] = [];
  const added = new Set<string>();

  for (const frame of frames) {
    const lines = [...new Set((frame.texts || []).map((line) => line.trim()).filter(Boolean))]
      .filter((line) => line.length >= 3 && !repeatedTitleKeys.has(visualTextKey(line)));
    // The guide cover contains category/headline text, not a venue card.
    if (lines.length === 0 || lines.some((line) => VISUAL_GUIDE_RE.test(line))) continue;

    // Venue cards use the final line for an area. The preceding one or two
    // lines are the display name (e.g. "THE PRIMO BY" + "MANN & SALWA").
    const nameLines = lines.length > 1 ? lines.slice(0, -1) : lines;
    const name = nameLines.join(' ').replace(/\s+/g, ' ').trim();
    const key = visualTextKey(name.replace(/^@/, ''));
    if (key.length < 3 || added.has(key) || GENERIC_NAMES.has(key)) continue;

    const frameEvidence = bundle.items.filter((item) =>
      item.source === 'vision_ocr' && item.frames?.includes(frame.frameIndex)
    );
    const nameEvidence = frameEvidence
      .filter((item) => nameLines.some((line) => visualTextKey(item.text) === visualTextKey(line)))
      .map((item) => item.id);
    if (nameEvidence.length === 0) continue;

    candidates.push({
      name,
      mention_type: name.startsWith('@') ? 'handle' : 'explicit',
      role: 'featured',
      name_evidence: nameEvidence,
      location_evidence: city ? frameEvidence.filter((item) => visualTextKey(item.text).includes(visualTextKey(city))).map((item) => item.id) : [],
      city,
      neighborhood: '',
      address: '',
      base_category: baseCategory,
      category: baseCategory,
      description: '',
      search_query: '',
    });
    added.add(key);
  }
  return candidates;
}

function generateFallbackAnalysis(content: SocialContent, bundle: EvidenceBundle, places: PlaceExtraction[]): Record<string, any> {
  const caption = (content.caption || '').trim();
  const summary = caption.length > 0 ? caption.split(/\s+/).slice(0, 20).join(' ') : `Social media post by @${content.authorUsername}`;

  const hashtags = (content.hashtags || []).map((h: string) => h.replace(/^#/, ''));
  const captionWords = caption.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const stopwords = new Set(['this', 'that', 'with', 'from', 'have', 'were', 'what', 'your', 'about', 'some', 'they', 'there', 'here', 'when', 'which', 'where']);
  const keywords = Array.from(new Set([...hashtags, ...captionWords.filter((w) => !stopwords.has(w))])).slice(0, 5);

  let primary_category = 'CITY';
  if (places.length > 0 && places[0].category) {
    primary_category = places[0].category;
  } else if (hashtags.some((h) => /food|eats|restaurant|cafe|dinner|brunch/i.test(h))) {
    primary_category = 'RESTAURANTS';
  } else if (hashtags.some((h) => /travel|trip|explore|vacation/i.test(h))) {
    primary_category = 'TRAVEL';
  }

  const detectedCity = LocationService.detectCityFromText(caption) || (places.length > 0 ? places[0].city : '');

  return {
    summary,
    primary_category,
    topics: hashtags.slice(0, 3),
    keywords,
    tone: ['informative'],
    niche: primary_category.toLowerCase(),
    is_promotional: Boolean(content.paidPartnership),
    is_sponsored: Boolean(content.paidPartnership),
    promotion_type: content.paidPartnership ? 'sponsored' : '',
    call_to_actions: [],
    offers: [],
    primary_audience: 'General',
    audience_interests: hashtags.slice(0, 2),
    geographic_focus: detectedCity ? [detectedCity] : [],
    audience_intent: 'Inspiration',
    audience_confidence: 0.6,
  };
}

export class AiEnrichmentService {
  static countDistinctSourceAddresses(texts: string[]): number {
    return distinctSourceAddressCount(texts);
  }

  static buildEvidence(content: SocialContent, media: MediaEvidenceInput): EvidenceBundle {
    return buildEvidence(content, media);
  }

  /** Places only (restricted posts, cached re-extraction). */
  static async extractPlaces(content: SocialContent, media: MediaEvidenceInput): Promise<PlaceExtractionOutcome> {
    const bundle = buildEvidence(content, media);
    if (bundle.items.length === 0) return { places: [], rejected: [] };
    try {
      const { raw, truncated } = await callExtractionModel(bundle, false, RECOVERY_OUTPUT_TOKENS);
      if (truncated) plog('model', 'Places-only response hit the output budget', undefined, 'warn');
      return finalizeCandidates(parseCandidates(raw), bundle, content.authorUsername);
    } catch (err: any) {
      plog('model', 'Places-only extraction AI call failed; generating fallback candidates from evidence', { error: err.message || String(err) }, 'warn');
      const fallbackCandidates = generateFallbackCandidates(content, bundle);
      return finalizeCandidates(fallbackCandidates, bundle, content.authorUsername);
    }
  }

  /** Legacy signature: plain transcript text and OCR strings. */
  static async extractPlace(
    content: SocialContent,
    transcript: string,
    ocrTexts: string[]
  ): Promise<PlaceExtraction[]> {
    const { WhisperService } = await import('./whisper.service');
    const outcome = await this.extractPlaces(content, {
      ocrTexts,
      transcript: WhisperService.fromStoredText(transcript),
    });
    return outcome.places;
  }

  /** One model call returns both the content analysis and the place candidates. */
  static async analyzeContent(
    content: SocialContent,
    rawApifyData: any,
    media: MediaEvidenceInput
  ): Promise<{ analysis: AiAnalysisResult; places: PlaceExtraction[]; rejected: PlaceExtractionOutcome['rejected']; warning?: string } | null> {
    const bundle = buildEvidence(content, media);
    plog('evidence', `Evidence built: ${bundle.items.length} items`, {
      availability: bundle.availability,
      bySource: bundle.items.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.source]: (counts[item.source] || 0) + 1 }), {}),
      items: bundle.items.map((item) => `${item.id} ${item.source}: ${item.text.slice(0, 120)}`),
    });

    let parsed: any = {};
    let outcome: PlaceExtractionOutcome = { places: [], rejected: [] };
    let warning: string | undefined;

    if (bundle.items.length > 0) {
      try {
        const { raw, truncated } = await callExtractionModel(bundle, true, MAX_OUTPUT_TOKENS);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          throw new Error('[AI Analysis] Model returned invalid JSON.');
        }
        parsed = isRecord(parsedJson) && isRecord(parsedJson.analysis) ? parsedJson.analysis : {};

        let candidates: RawPlaceCandidate[] = [];
        try {
          candidates = parseCandidates(raw);
        } catch (placeError) {
          plog('model', 'Combined response had no usable places', { error: String(placeError) }, 'warn');
        }
        outcome = await finalizeCandidates(candidates, bundle, content.authorUsername);

        const visualGuideCandidates = generateVisualGuideCandidates(content, media, bundle);
        if (visualGuideCandidates.length > 0) {
          const visualGuideOutcome = await finalizeCandidates(visualGuideCandidates, bundle, content.authorUsername);
          const before = outcome.places.length;
          outcome = {
            places: mergeSameEntities([...outcome.places, ...visualGuideOutcome.places], bundle),
            rejected: [...outcome.rejected, ...visualGuideOutcome.rejected],
          };
          const added = outcome.places.length - before;
          if (added > 0) {
            plog('model', 'Recovered source-backed venue cards from Vision frames', {
              candidates: visualGuideCandidates.length,
              added,
              places: outcome.places.map((place) => place.name),
            }, 'info');
          }
        }

        // Recovery: the list was cut off, or the evidence has more distinct
        // street-address rows than places returned. A places-only pass is merged
        // by entity; generated data is never trusted without the same checks.
        const sourceAddressCount = distinctSourceAddressCount(bundle.items.map((item) => item.text));
        // Every 📍-marked line (any pin style, normalised) is a location the creator pointed at.
        const markedLocations = bundle.items.filter((item) => /^📍/u.test(item.text)).length;
        const expected = Math.max(sourceAddressCount, markedLocations);
        if (truncated || expected > outcome.places.length) {
          plog('model', 'Running places-only recovery pass', {
            truncated,
            sourceAddresses: sourceAddressCount,
            markedLocations,
            placesSoFar: outcome.places.length,
          }, 'warn');
          try {
            const found = outcome.places.map((place) => place.name).filter(Boolean).join(', ');
            const note = `CHECK: the evidence marks ${markedLocations} location(s) with 📍 and ${sourceAddressCount} street address(es), ` +
              `but only ${outcome.places.length} place(s) were returned${found ? ` (${found})` : ''}. Return EVERY place, including those already found.`;
            const recovery = await callExtractionModel(bundle, false, RECOVERY_OUTPUT_TOKENS, note);
            const recovered = await finalizeCandidates(parseCandidates(recovery.raw), bundle, content.authorUsername);
            outcome = {
              places: mergeSameEntities([...outcome.places, ...recovered.places], bundle),
              rejected: [...outcome.rejected, ...recovered.rejected],
            };
          } catch (recoveryError: any) {
            plog('model', 'Recovery pass failed', { error: recoveryError.message || String(recoveryError) }, 'warn');
          }
        }
      } catch (error) {
        warning = analysisFallbackWarning(error);
        plog('model', 'All AI extraction providers failed; fulfilling request using metadata & evidence fallback', {
          error: error instanceof Error ? error.message : String(error),
          warning,
        }, 'warn');
        const fallbackCandidates = generateFallbackCandidates(content, bundle);
        outcome = await finalizeCandidates(fallbackCandidates, bundle, content.authorUsername);
        parsed = generateFallbackAnalysis(content, bundle, outcome.places);
      }
    } else {
      plog('model', 'No evidence available; skipping the model call', undefined, 'warn');
    }

    const places = outcome.places;
    const ocrAvailable = bundle.items.some((item) => item.source === 'ocr' || item.source === 'vision_ocr');
    const transcriptItems = bundle.items.filter((item) => item.source === 'speech');
    const transcriptText = transcriptItems.map((item) => item.text).join(' ');

    const analysis: AiAnalysisResult = {
      platform: content.platform,
      content: {
        content_id: content.contentId,
        content_type: content.contentType,
        url: rawApifyData?.url || rawApifyData?.webVideoUrl || '',
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
        id: rawApifyData?.ownerId || rawApifyData?.authorMeta?.id || '',
        username: content.authorUsername,
        full_name: content.authorFullName,
        profile_url: null,
        verified: null,
      },
      caption_analysis: {
        original_caption: content.caption,
        summary: parsed.summary || '',
        keywords: parsed.keywords || [],
        hashtags: content.hashtags,
        mentions: content.mentions,
        call_to_actions: parsed.call_to_actions || [],
      },
      entities: {
        brands: [], products: [], companies: [], restaurants: [], services: [], people: [], websites: [],
        locations: places.map((place) => ({
          name: place.name || '',
          type: place.category,
          source: (place.evidence_sources || []).join(','),
          explicit: place.mention_type !== 'indirect',
          confidence: place.confidence,
          context: place.explanation,
          city: place.city || null,
          address: place.address || null,
        })),
      },
      visual_analysis: { visible_text: [], products_visible: [], brands_visible: [], people_visible: [], locations_visible: [], objects_visible: [], logos_visible: [] },
      audio_analysis: {
        artist: content.musicInfo?.artist_name || null,
        song_name: content.musicInfo?.song_name || null,
        audio_id: content.musicInfo?.audio_id || null,
        uses_original_audio: content.musicInfo?.uses_original_audio ?? null,
        transcript: transcriptText || null,
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
      content_style: { tone: parsed.tone || [], style: [], format: '' },
      engagement: {
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
      hashtags: { all: content.hashtags, brand: [], product: [], industry: [], location: [], campaign: [], topic: [], generic: [] },
      campaign_insights: { relevant_industries: [], relevant_brand_categories: [], relevant_product_categories: [], relevant_audiences: [], relevant_locations: [], potential_campaign_themes: [], potential_collaboration_categories: [], campaign_suitability: '', reasoning: '' },
      influencer_analysis: { niche: parsed.niche || '', sub_niches: [], content_strengths: [], potential_collaboration_types: [], potential_brand_categories: [] },
      data_quality: {
        available_fields: Object.entries(bundle.availability).filter(([, value]) => !/^(none|0|not available|no video)$/.test(value)).map(([key]) => key),
        missing_fields: Object.entries(bundle.availability).filter(([, value]) => /^(none|0|not available)$/.test(value)).map(([key]) => key),
        unavailable_metrics: [],
        media_analysis_available: ocrAvailable || transcriptItems.length > 0,
        ocr_available: ocrAvailable,
        transcript_available: transcriptItems.length > 0,
      },
      extracted_information: places.map((place) => ({
        field: 'place',
        value: place.name || '',
        source: (place.evidence_ids || []).join(','),
        confidence: place.confidence,
      })),
    };

    return { analysis, places, rejected: outcome.rejected, ...(warning ? { warning } : {}) };
  }
}
