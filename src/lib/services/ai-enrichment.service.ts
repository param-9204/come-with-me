import { executeAICall, supportsTemperature } from './ai-client';
import { LocationService } from './location.service';
import { plog } from './pipeline-log';
import {
  BASE_CATEGORIES, GENERIC_NAMES, buildEvidence, formatEvidenceForPrompt, mergeSameEntities, normalizeForMatch, resolveHiddenGem,
  sanitizeCandidateLocation, scoreAndFilterCandidates,
  type BaseCategory, type EvidenceBundle, type MediaEvidenceInput, type RawPlaceCandidate,
} from './place-evidence.service';
import type { SocialContent, AiAnalysisResult, GptVisionFrameResult, PlaceExtraction, PlaceCategory } from '../types/social';

const PLACE_CATEGORIES = [
  'RESTAURANTS', 'COFFEE', 'TRAVEL', 'ADVENTURE', 'NATURE', 'CITY',
  'SHOPPING', 'NIGHTLIFE', 'CULTURE', 'HIDDEN GEMS', 'BARS',
] as const;

const MENTION_TYPES = ['explicit', 'handle', 'indirect'] as const;
const ROLES = ['featured', 'recommended', 'mentioned_only', 'background'] as const;

/**
 * Completion budget per extraction call. A 48-place guide used about 3,500
 * output tokens, so 16,000 leaves room for roughly 200 places; a truncated
 * result still triggers the grounded recovery pass. The requested budget
 * counts against the account's tokens-per-minute limit (gpt-4o-mini: 200k
 * per minute on this account as of 2026-09-24).
 */
const MAX_OUTPUT_TOKENS = 16_000;
const RECOVERY_OUTPUT_TOKENS = 16_000;

/**
 * Output caps OpenAI enforces per model. A larger request is not trimmed: it
 * fails with HTTP 400 and every extraction falls back to "AI analysis is
 * temporarily unavailable". Both caps were confirmed from the API's own error
 * message on 2026-09-24. Models not listed get the requested budget.
 */
const MODEL_OUTPUT_CAPS: Array<[RegExp, number]> = [
  [/^gpt-4o-mini\b/i, 16_384],
  [/^gpt-4o\b/i, 16_384],
];

function outputBudget(model: string, requested: number): number {
  const cap = MODEL_OUTPUT_CAPS.find(([pattern]) => pattern.test(model.replace(/^openai\//, '')))?.[1];
  return cap ? Math.min(requested, cap) : requested;
}

function analysisFallbackWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|rate[_ -]?limit|quota|tokens?\s+per\s+min|tpm)/i.test(message)
    ? 'AI providers are rate-limited. The request was completed with verified scraped data, OCR, and transcript; no unverified AI place candidates were added.'
    : 'AI analysis is temporarily unavailable. The request was completed with verified scraped data, OCR, and transcript; no unverified AI place candidates were added.';
}

// ──────────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────────

const PLACE_RULES = `You extract real-world places, and where each one is, from ONE Instagram/TikTok post. Use ONLY the numbered EVIDENCE lines — never your own knowledge of places, cities, or addresses.

EVIDENCE SOURCES (id prefix)
C caption · L platform location tag · A tagged / collab / mentioned account with its display name · O on-screen text from OCR (may contain letter errors) · V on-screen text from high-accuracy OCR · S speech transcript · H hashtags · K comments (the creator's own comments are marked) · X image description · B creator bio (context only, never enough on its own).
Line tags: t= seconds into the video · img=N the Nth image or carousel slide (lines with the same img are on the same slide) · scene = text physically in the filmed scene (shop or street sign, menu, packaging, cup, billboard). On-screen lines without "scene" were added by the creator: titles, stickers, list overlays, pins, subtitles.
A place can appear in only ONE independent venue source. Captions are often silent while the venue name is only on screen, only spoken, or only in the location tag. An account tag alone is not independent venue evidence; use it only to confirm the canonical name of a place established elsewhere. Read every line before answering.

METHOD — work through these steps in order
1. POST SHAPE. Decide what the post is: one venue (review, visit, vlog), a list or guide (a caption list, list slides, one venue card per scene or slide, a map of areas), an itinerary (days, stops, "first / next / last"), or a mix. Guides with 20–60 places are normal.
2. LOCATION CONTEXT. Collect every city, neighbourhood and area the evidence names, and what each one covers. The most specific source wins:
   - One place (wins over everything): text on the same line, the same list item, the same slide (same img) or the same moment (t within about 3 seconds). "📍 Weehawken NJ Waterfront" is in Weehawken even when the location tag says New York.
   - A section: a heading such as "BROOKLYN:", "Day 2 – Williamsburg", "📍 Paris" or "London spots" covers every item below it until the next heading. In a multi-city post each place takes the city of its own section.
   - The whole post (used only when nothing more specific applies): the location tag, a title ("NYC VEGETARIAN FOOD GUIDE"), a location hashtag (#phillyeats → Philadelphia), or a city said aloud. When one city is named and nothing contradicts it, it applies to every place.
3. CANDIDATES. Walk the evidence line by line and write down every place:
   - Caption and creator comments: every item of a list is one candidate, with or without bullets, numbers, emoji or pins. Headings that name a cuisine, category or price ("🥡Asian:", "Pizza :", "Cafe:", "Under $20") are not places; they describe the items below them.
   - Venue cards: when each slide or scene shows one venue, its name is the large text, sometimes split over two or three lines that must be joined ("THE PRIMO BY" + "MANN & SALWA", "UNDER THE NEEM" + "TREES"). The smaller line under it is that venue's area or street: it goes into neighborhood or address, never a separate place. A handle on a card ("@MANGO") is the venue's name. A slide that shows only an area name, with no venue ("Greenwich Village", "LES"), is an area-guide entry: return it by that name, category CITY.
   - On-screen text: a short creator label shown for one scene or on one slide names the place shown there; text repeated on every frame is the post's title. A "scene" line is a place only when it is the storefront sign of the venue being visited. Street signs, billboards, cup logos, packaging, posters and menus are never places on their own, but they can confirm a place named elsewhere (a cup reading "ANGELINA" supports "Angelina Paris" from the caption).
   - Vlog captions: in "14:35 coffee at café pigalle", "checked in" + "at hotel massé" or "dinner at abri soba", the place is the name after "at"; the time and the activity are not part of the name. Words shown one at a time as subtitles ("iced", "latte", "good") are speech, never places.
   - Storefronts: the brand is the name; a generic line on the sign ("boulangerie de quartier", "bakery & cafe", "since 1903", "open daily") describes it.
   - 📍 lines: every 📍 line that names a venue or an area is a place: return it, with the city or area written on it. A 📍 line that only describes a route or directions follows the route rule below.
   - Events (parade, festival, concert, market day) are not places: return the venue or area where the event happens, usually its 📍 line, and put the event in "description". A pop-up, market or exhibition that has its own venue name or street address is a place; one listed with no venue or address is an event.
   - A business posting about itself ("our signature croissant", "order now", its own 📍 branch addresses) is the place, even though it is the creator: return one entry per branch with that branch's address.
   - Streets, areas and landmarks named only to describe a route, directions, a crowd tip, a meeting point or how to get somewhere ("the parade goes up 6th Avenue from Canal Street") are mentioned_only.
   - Speech: venues the creator says they are at, visiting or recommending.
   - Accounts: a tagged or mentioned account is supporting metadata, not a place by itself. Return it as a place only when another source independently shows or recommends the venue: a caption recommendation, location pin, venue label, speech, list item, or address. Credits, collaborators, friends, photographers, creators, brands and bare tags are not places. A caption line that visits or recommends an @handle ("pilates class at @togetherathletics", "coffee from @mochameltcafe", including a "things I wish I had time for" list) is a caption recommendation: return it, named by the account's display name, or by the handle when there is none.
   - Other people's comments: places they suggest ("you left out @x", "try Y") are mentioned_only, because the creator did not choose them.
4. FIELDS. Split each candidate's text into fields:
   - name: the venue's own name only, as written. Remove words that are not part of the name: cuisine or type tags ("Hangawi-korean" → "Hangawi", "Uptown thai- Thai" → "Uptown thai"), notes and rules ("Indian accent - children under 10 not allowed" → "Indian accent", "NY dosas - food cart" → "NY dosas"), prices, hours, ratings, numbering, emoji, pins, "@", and a trailing phrase that only repeats the city ("Salswee in NYC" → "Salswee"). Keep words that belong to the name ("Tamarind Tribeca", "Joe's Pizza", "Franchia Vegan"). Put the removed descriptive words in "description".
   - address: a street address written with the place (same line, list item, slide or moment), copied exactly ("140 N. 2nd", "209 Chestnut St"). A line that is only an address is never a place: attach it to the venue on the same line, slide or moment. A street sign in the scene ("W 23 St") is not an address.
   - neighborhood and city: from step 2, in this order: the place's own line, then its section, then the whole post. When the place's own line names another town, state or country ("📍 Weehawken NJ Waterfront"), that is its city, even in a post about a different city.
5. ROLE. featured = shown, visited, reviewed · recommended = suggested but not shown · mentioned_only = comparison, joke, "better than X", passing reference, other people's suggestions · background = visible but not the subject (a logo on a cup, a passing sign, a photo credit). Every entry of the creator's own guide, list or itinerary is featured or recommended, never mentioned_only ("Day 2 - Evening plans @brasseriecognac", "SHOPS: Vowels, PHOS").
6. CHECK. Count the list items and venue labels you found in step 3 and make sure every one is in "places"; a venue listed twice is returned once. Never stop early, summarise, or trust a stated count ("top 5" with 7 entries → 7).

WHAT IS A PLACE
A specific, named, physical location someone can visit: restaurant, cafe, bar, club, shop, market, food cart or truck, hotel, museum, gallery, park, beach, trail, viewpoint, landmark, street, or a town/island that is itself the destination.
Not places: people, the creator, DJs/artists, the audio track, brands or products with no specific location (a drink brand, an app), dishes, events without a venue, generic phrases ("this cafe", "the best pizza spot"), website addresses and watermarks.
A city, state, or country that only says WHERE the other places are is location context: put it in those places' "city" field instead of returning it as a place.

NAME
- Fix an OCR letter error only when another line confirms the spelling (O3 "CAFE LUMIFRE" + A1 "Café Lumière" → "Café Lumière").
- If an account identifies the venue, prefer its display name from the A line ("Joe's Pizza" for @joespizzanyc). With no display name anywhere, use the handle without @ and set mention_type "handle".
- Never use a headline, slogan, ranking ("#1"), price, hashtag, or caption sentence as a name.
- mention_type "indirect": the creator clearly describes ONE specific place without naming it ("the horror bookstore on Frankford Ave"). Set name "" and search_query to words copied from the evidence plus the city ("horror bookstore Frankford Ave Philadelphia"). Otherwise search_query "". Anything written with its name — a venue, a park, a neighbourhood such as "LES" — is explicit, never indirect.
- mention_type "explicit" for every normally named place.
- map_name: when the post writes a place's name in a language other than the one the city uses ("Statua della Libertà", "Ponte di Brooklyn" or "Shopping sulla 5th Avenue" in New York), give the name as the city's own signs and maps write it ("Statue of Liberty", "Brooklyn Bridge", "5th Avenue"). Keep "name" exactly as written in the post. Otherwise map_name is "".

LOCATION
- city / neighborhood / address only when the evidence states them: a line, a heading, the location tag, or a location hashtag. Never invent, complete, or move an address. Sizes, prices, dates, and counts are not addresses.
- "📍" marks a location marker. Creators use many styles (📍 📌 🗺️ pins, map-pin icons, location stickers, "Location:"/"Address:" labels); all are shown as "📍". Everything on one marker belongs to the same place: "📍 Buvette · 42 Grove St · West Village" gives name, address and neighbourhood. A marker holding only an address or area locates the venue shown or named in the same scene or slide.
- Same moment: on-screen text and speech within about 3 seconds of each other describe the same scene. Use this to pair a name on screen with a city or address spoken aloud, and the reverse.
- Map and area-guide labels are destinations, not scenery: when a post shows several named neighbourhoods, towns, parks, or areas on a map/list, return each as category CITY with role featured or recommended. This applies even when OCR splits a label across adjacent lines ("Ridge" + "Wood" = "Ridgewood").
- When the post labels its places with pin stickers or overlays, only those labels are places; other on-screen text is scenery.

EVIDENCE IDS (required)
name_evidence: ids of the lines that contain the name or identify the venue. location_evidence: ids supporting city / neighborhood / address, including the heading or title a city came from. Cite only ids present in EVIDENCE.

CATEGORY
base_category = what the place IS: RESTAURANTS (restaurants, food spots, bakeries, street food) · COFFEE (cafes, coffee, tea) · BARS (bars, pubs, cocktail/wine bars, breweries) · NIGHTLIFE (clubs, live music, late-night venues) · SHOPPING (shops, markets, malls, boutiques) · CULTURE (museums, galleries, theatres, historic or religious sites) · NATURE (parks, beaches, lakes, mountains, gardens, trails) · ADVENTURE (activities: tours, diving, climbing, theme parks, water sports) · TRAVEL (hotels, resorts, stays; towns/islands visited as a trip) · CITY (streets, squares, neighbourhoods, city viewpoints, urban landmarks). A list heading such as "Pizza" or "Cafe" tells you the category of the items under it.
category = base_category, or "HIDDEN GEMS" only when the evidence explicitly calls the place a hidden gem, secret, underrated, hole-in-the-wall, or locals-only spot.
description: at most 12 words taken from the evidence, or "".`;

const ANALYSIS_RULES = `ANALYSIS (compact, from evidence only):
- summary: factual post summary in at most 20 words. Do not add claims that are absent from EVIDENCE.
- primary_category: exactly one of RESTAURANTS, COFFEE, BARS, NIGHTLIFE, SHOPPING, CULTURE, NATURE, ADVENTURE, TRAVEL, CITY, HIDDEN GEMS, or "". Prefer the category supported by the featured places; otherwise use "".
- topics and keywords: at most 3 each; include only meaningful themes/terms explicit in EVIDENCE. Do not include a hashtag merely because it exists.
- tone: at most 2 labels describing the creator's writing or speaking style, not the atmosphere of a venue. Use [] when unsupported.
- niche: explicit content niche only, otherwise "".
- is_sponsored: true only with an explicit paid/sponsored/partner/advertisement disclosure. is_promotional: true only when the post explicitly promotes a brand, product, place, event, or offer. promotion_type: sponsored, affiliate, gifted, self_promotion, event, or "".
- call_to_actions: at most 3 direct calls to action stated in EVIDENCE (for example, "save this" or "book now"); do not convert ordinary commentary into a CTA.
- offers: at most 3 explicit prices, discounts, deals, menus, or promotion codes; otherwise [].
- primary_audience: return only an explicitly stated or strongly post-level indicated intended audience; otherwise "". Do not infer demographics from a venue.
- audience_interests: at most 2 explicit interests. geographic_focus: at most 2 city/region/country names explicitly stated in EVIDENCE; never infer geography from venue knowledge.
- audience_intent: exactly one of Inspiration, Planning, Education, Purchase, Entertainment, or "".
- audience_confidence: number 0 to 1 for the audience fields: 0 when unsupported, 0.5 for indirect post-level evidence, 0.8 for explicit audience wording, 1 only for an unambiguous direct statement.
Use ""/[]/false/0 when unsupported.`;
 

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
    map_name: { type: 'string' },
  },
  required: ['name', 'mention_type', 'role', 'name_evidence', 'location_evidence', 'city', 'neighborhood', 'address', 'base_category', 'category', 'description', 'search_query', 'map_name'],
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

/**
 * Words that describe a venue rather than name it, as creators append them to list entries
 */
const DESCRIPTOR_WORDS = new Set([
  'american', 'asian', 'chinese', 'szechuan', 'sichuan', 'cantonese', 'hunan', 'korean', 'japanese', 'thai', 'vietnamese',
  'indian', 'south', 'north', 'gujarati', 'punjabi', 'bengali', 'italian', 'mexican', 'mediterranean', 'ethiopian', 'french',
  'greek', 'lebanese', 'turkish', 'spanish', 'middle', 'eastern', 'caribbean', 'peruvian', 'brazilian', 'filipino',
  'vegan', 'vegetarian', 'veg', 'plant', 'based', 'food', 'cart', 'truck', 'street', 'fine', 'dining', 'casual',
  'cuisine', 'kitchen', 'bakery', 'dessert', 'desserts', 'brunch', 'cafe', 'café', 'coffee', 'tea', 'bar', 'restaurant',
  'and', '&', 'style', 'fusion', 'only', 'options',
]);
/** Visitor notes appended to list entries: "children under 10 not allowed", "cash only", "$$". */
const NOTE_RE = /\b(?:children|kids|not allowed|allowed|cash only|reservations?|closed|must try|walk[- ]?ins?|per person|open late)\b|^\$+$/i;

function isDescriptorTail(tail: string): boolean {
  const words = tail.toLowerCase().replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((word) => DESCRIPTOR_WORDS.has(word)) || NOTE_RE.test(tail);
}

/**
 * Split a trailing cuisine tag or note off a name. Only separators creators use
 * for annotations count (a dash or hyphen, a bar, a closing parenthesis), and
 * only when every word after it is descriptive, so "Jean-Georges" and
 * "Canto - West Village" are left for the model's own fields.
 */
export function splitNameDescriptor(name: string, city = ''): { name: string; note: string } {
  // "Salswee in NYC", "Café Lumière in Paris": a trailing phrase that is only
  // the place's city is where it is, not part of its name.
  const cityTail = name.match(/^(.*?\p{L}.*?)\s+(?:in|at)\s+([\p{L}][\p{L} .'-]{1,30})$/u);
  if (cityTail && (cityTail[1].match(/\p{L}/gu) || []).length >= 3 && cityTail[2].trim().split(/\s+/).length <= 3) {
    const tail = cityTail[2].trim();
    const tailCity = LocationService.cleanCityName(tail);
    const isPlaceCity = !!city && tailCity.toLowerCase() === LocationService.cleanCityName(city).toLowerCase();
    const isKnownCityAlias = !!LocationService.detectCityFromText(tail) && LocationService.detectCityFromText(tail) === tailCity;
    if (isPlaceCity || isKnownCityAlias) return { name: cityTail[1].trim(), note: `in ${tail}` };
  }
  const patterns = [
    /^(.*?\p{L}.*?)\s*\(([^()]+)\)\s*$/u,
    /^(.*?\p{L}.*?)\s*[|]\s*(.+)$/u,
    /^(.*?\p{L}.*?)\s*[-–—]\s*(.+)$/u,
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (!match) continue;
    const head = match[1].trim();
    const tail = match[2].trim();
    if ((head.match(/\p{L}/gu) || []).length >= 3 && isDescriptorTail(tail)) return { name: head, note: tail };
  }
  return { name, note: '' };
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
    const cleanedName = str(value.name)
      .replace(/^@/, '')
      .replace(/[\u2122\u00AE\u00A9]\uFE0F?/g, '')
      // Flags are pairs of regional-indicator letters, not pictographs ("Mariscos El Submarino \uD83C\uDDF2\uD83C\uDDFD").
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanedName.includes('#')) continue;
    // A cuisine tag or visitor note left in the name stops the map lookup from
    // matching the venue ("Hangawi-korean" vs Google's "Hangawi").
    const { name, note } = splitNameDescriptor(cleanedName, str(value.city));
    const description = str(value.description) || note;
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
      description: description.split(/\s+/).slice(0, 16).join(' '),
      search_query: str(value.search_query),
      map_name: str(value.map_name),
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
  // Without a road suffix, the short social form needs a street-shaped word
  // after the number: an ordinal ("140 N. 2nd") or a capitalised name ("400
  // Ranstead"). Prose such as "children under 10 not allowed" would otherwise
  // become the address "10 not Street".
  const hasRoadSuffix = /\s(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway)\.?$/i.test(normalized);
  if (!hasRoadSuffix) {
    const streetWord = normalized
      .replace(/^\d{1,6}\s+/, '')
      .replace(/^(?:[NSEW]\.?|North|South|East|West)\s+/i, '')
      .split(/\s+/)[0] || '';
    const ordinal = /^\d+(?:st|nd|rd|th)$/i.test(streetWord);
    const properName = /^\p{Lu}/u.test(streetWord) && !PROSE_WORDS.has(streetWord.toLowerCase());
    if (!ordinal && !properName) return false;
  }
  return true;
}

/** Words that follow a number in prose, never a street name ("10 not allowed", "5 Under 20"). */
const PROSE_WORDS = new Set([
  'not', 'under', 'over', 'to', 'for', 'of', 'and', 'or', 'per', 'at', 'in', 'on', 'with', 'the', 'a', 'an',
  'kids', 'children', 'allowed', 'only', 'people', 'guests', 'min', 'mins', 'minutes', 'hours', 'years', 'am', 'pm',
]);

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

  // A number that starts a venue's own name ("11 Madison Park", "15 East") is
  // not a street address to hand to a neighbouring list entry.
  const nameKeys = places.map((place) => collapseAlnum(place.name || '')).filter(Boolean);
  const found = findStreetAddressesInText(blob).filter((addr) => {
    const rawKey = collapseAlnum(blob.slice(addr.index, addr.end));
    return !nameKeys.some((key) => key.includes(rawKey));
  });
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
  // Scene text is excluded: a billboard or street sign ("1540 BROADWAY",
  // "W 23 St") is not the address of the venue named nearby.
  const creatorScreenText = bundle.items
    .filter((item) => ['ocr', 'vision_ocr', 'comment_creator'].includes(item.source) && !item.scene)
    .map((item) => item.text);
  const addressSources = [caption, ...creatorScreenText, speech].filter(Boolean);

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

/** Bulleted or numbered list lines are list entries whatever their length. */
// A word must follow the bullet or number: prices ("9.95") are not list lines.
const LIST_BULLET_RE = /^\s*(?:[•·●▪◦\-–*]|\d{1,2}[.)])\s*[\p{L}@"'“]/u;

function letters(value: string): number {
  return (value.match(/\p{L}/gu) || []).length;
}

/** A section heading inside a list: "🥡Asian:", "Pizza :", "DAY 2:". */
function isListHeading(line: string): boolean {
  return /:\s*$/.test(line) && line.trim().split(/\s+/).length <= 5 && letters(line) >= 2;
}

/**
 * A short line that can be one list entry: not a sentence, not hashtags.
 * Entries often carry a note ("Indian accent - children under 10 not
 * allowed"), so up to ten words still count.
 */
function isShortEntry(line: string): boolean {
  const trimmed = line.trim();
  return letters(trimmed) >= 3 &&
    trimmed.length <= 70 &&
    trimmed.split(/\s+/).length <= 10 &&
    !/[.!?]$/.test(trimmed) &&
    !trimmed.startsWith('#') &&
    !isListHeading(trimmed);
}

/**
 * Lines of the creator's own text that look like entries of a list: bulleted
 * or numbered lines, plus runs of at least three short lines (headings may sit
 * between them, as in "🥡Asian:" / "Planta queen" / "Beyond sushi"). Used only
 * to decide whether a places-only recovery call is worth making.
 */
export function countListEntries(texts: string[]): number {
  let total = 0;
  for (const text of texts) {
    let run = 0;
    const flush = () => {
      if (run >= 3) total += run;
      run = 0;
    };
    for (const line of text.split(/\r?\n/)) {
      if (letters(line) < 2) continue; // "." spacer lines neither count nor break a run
      if (LIST_BULLET_RE.test(line)) { total += 1; continue; }
      if (isListHeading(line)) continue;
      if (isShortEntry(line)) run += 1;
      else flush();
    }
    flush();
  }
  return total;
}

/** A name that is a street address: house number, street, street word ("331 West 4th Street"). */
const ADDRESS_NAME_RE = /^\d{1,6}\s+.*\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|pl|place|way|pkwy|parkway|ct|court)\.?$/i;

/** Recovery runs when fewer than this share of the list entries became places. */
const LIST_RECOVERY_RATIO = 0.7;

/**
 * Distinct creator labels shown one per slide or scene (venue cards, area
 * slides). Title text repeated across frames, guide covers, scene text, web
 * addresses, street signs and subtitle-length sentences are not labels. Each
 * card counts once however many frames it stays on screen.
 */
export function countScreenCards(frames: GptVisionFrameResult[]): number {
  if (frames.length < 2) return 0;
  const seen = new Map<string, Set<number>>();
  for (const frame of frames) {
    for (const line of new Set(frame.texts || [])) {
      const key = visualTextKey(line);
      if (key) seen.set(key, new Set([...(seen.get(key) || []), frame.frameIndex]));
    }
  }
  const isTitle = (key: string) => {
    const count = seen.get(key)?.size || 0;
    return count >= 3 && count >= frames.length * 0.4;
  };
  const cards = new Set<string>();
  for (const frame of frames) {
    const sceneKeys = new Set((frame.sceneTexts || []).map(visualTextKey));
    const lines = (frame.texts || []).filter((line) => {
      const key = visualTextKey(line);
      return letters(line) >= 3 && !isTitle(key) && isCardLine(line, sceneKeys) && line.trim().split(/\s+/).length <= 6;
    });
    if (lines.length === 0 || lines.some((line) => GUIDE_COVER_RE.test(line))) continue;
    cards.add(visualTextKey(cardName(lines[0])));
  }
  return cards.size;
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
 * The model sometimes marks a plainly named place as "indirect" (name "",
 * search_query "LES New York"). When the query, minus the city, is exactly
 * one evidence line ("LES", "📍 Greenwich Village"), the place is named there:
 * use that line instead of a Google search that may not resolve it.
 */
function nameIndirectFromEvidence(candidate: RawPlaceCandidate, bundle: EvidenceBundle): RawPlaceCandidate {
  if (candidate.mention_type !== 'indirect' || candidate.name || !candidate.search_query) return candidate;
  let phrase = candidate.search_query.trim();
  for (const city of [candidate.city, LocationService.cleanCityName(candidate.city)]) {
    if (city && phrase.toLowerCase().endsWith(` ${city.toLowerCase()}`)) phrase = phrase.slice(0, -city.length).trim();
  }
  const key = normalizeForMatch(phrase);
  if (!key) return candidate;
  const line = bundle.items.find((item) =>
    item.source !== 'account' && normalizeForMatch(item.text.replace(/^📍\s*/u, '')) === key);
  if (!line) return candidate;
  plog('candidates', `"${phrase}" is named in ${line.id}; treated as a named place, not an indirect description`);
  return {
    ...candidate,
    name: line.text.replace(/^📍\s*/u, '').trim(),
    mention_type: 'explicit',
    name_evidence: [line.id],
    search_query: '',
  };
}

/**
 * Deterministic post-processing of model candidates:
 * ground location fields → refine from source text → verify names against
 * evidence and score → HIDDEN GEMS check → merge duplicates → resolve
 * indirect mentions (Google, single-result only).
 */
export async function finalizeCandidates(
  rawCandidates: RawPlaceCandidate[],
  bundle: EvidenceBundle,
  authorUsername: string,
  options: { resolveIndirect?: boolean } = {}
): Promise<PlaceExtractionOutcome> {
  const candidates = rawCandidates.map((candidate) => nameIndirectFromEvidence(candidate, bundle));
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
      ...(candidate.map_name && candidate.map_name !== candidate.name ? { map_name: candidate.map_name } : {}),
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

  const { places: scoredAll, rejected } = scoreAndFilterCandidates(refined, bundle);
  // A card's address line returned as its own "place" ("331 West 4th Street"
  // next to Corner Bistro at that address) is the venue's address, not a venue.
  const addressKeys = new Set(scoredAll.map((place) => collapseAlnum(place.address || '')).filter((key) => key.length >= 5));
  const scored = scoredAll.filter((place) => {
    const nameKey = collapseAlnum(place.name || '');
    if (!place.address && addressKeys.has(nameKey)) {
      rejected.push({ name: place.name || '', reason: "another place's street address" });
      return false;
    }
    return true;
  });
  for (const item of rejected) plog('candidates', `Rejected "${item.name}"`, { reason: item.reason });

  const categorized = scored.map((place) => ({
    ...place,
    category: resolveHiddenGem(place, bundle),
    // An area returned as a place ("Greenwich Village") is not its own neighbourhood.
    neighborhood: normalizeForMatch(place.neighborhood) === normalizeForMatch(place.name) ? '' : place.neighborhood,
  }));
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
  // The second look (it carries the CHECK note) may use a stronger model: see OPENAI_RECOVERY_MODEL.
  return executeAICall(note ? 'chat-recovery' : 'chat', async ({ client, model, isGroq }, reportUsage) => {
    maxTokens = outputBudget(model, maxTokens);
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

  // Tags identify accounts, not places.  In the no-model fallback we have no
  // independent judgement that a tag is a venue, so never manufacture a place
  // candidate from it.  Captions, pins, OCR venue labels, and addresses below
  // can still create a candidate when they provide venue evidence.

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
/**
 * A guide's cover or headline slide ("DINING SPOTS", "FOOD GUIDE", "Top 5").
 * Narrower than VISUAL_GUIDE_RE so a venue card such as "RUNGG PREMIUM
 * DINING" or "Cafe Lumière" is not mistaken for the cover.
 */
const GUIDE_COVER_RE = /\b(?:guides?|spots|places|itinerary|restaurants|caf(?:e|é)s|bars|things to do|where to|top\s*\d+|must[- ]visit)\b/i;
/**
 * Generic food words occur in ordinary reviews ("a bakery and cafe"), so they
 * do not establish a multi-place guide on their own. A guide needs explicit
 * list/collection language, or several deliberately labelled entries.
 */
const GUIDE_INTENT_RE = /\b(?:guide|itinerary|(?:top\s*\d+)|must[-\s]?visit|where\s+to\s+(?:eat|drink|go|visit|stay)|(?:best|favorite|favourite|hidden)\s+(?:restaurants?|caf(?:e|é)s?|coffee\s+shops?|bars?|spots?|places?)|(?:dining|food|restaurants?|caf(?:e|é)s?|coffee|bars?)\s+(?:spots?|places|guide))\b/i;
// A word must follow the bullet or number: menu prices ("9.95", "10.95") once
// counted as three list labels and opened the card gate on a plain review.
const STRUCTURED_VISUAL_ENTRY_RE = /^\s*(?:📍\s*\S|(?:[•·●▪◦\-–*]|\d{1,2}[.)])\s*[\p{L}@"'“])/u;

function visualTextKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Fewest distinct venue cards before on-screen text is treated as a card guide. */
const MIN_VISUAL_CARDS = 3;

/** Website addresses and watermarks: "thenomadic.com", "www.x.co". */
const WEB_ADDRESS_RE = /(?:^|\s)(?:www\.|https?:\/\/)|\b[\p{L}\p{N}-]+\.(?:com|net|org|co|io|in|uk|me|app|shop|store|tv)\b/iu;
/**
 * A street sign: a numbered street or a compass-prefixed street with no
 * building number ("W 23 St", "5th Ave", "E Houston St"). Named streets on
 * their own ("Abbey Road") are left alone; they can be destinations.
 */
const STREET_SIGN_RE = /^(?:(?:(?:[NSEW]|north|south|east|west)\.?\s+)?\d{1,3}(?:st|nd|rd|th)?|(?:[NSEW]|north|south|east|west)\.?\s+\p{L}+)\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|pl|place|dr|drive)\.?$/iu;

/**
 * Card text that can name a venue: creator overlays only. Scene text (a sign
 * on a building, a cup logo), web addresses and bare street signs never can.
 */
function isCardLine(line: string, sceneKeys: Set<string>): boolean {
  return !sceneKeys.has(visualTextKey(line)) && !WEB_ADDRESS_RE.test(line) && !STREET_SIGN_RE.test(line.trim());
}

/** "📍 Buvette · 42 Grove St" → "Buvette": the name part of a pinned card line. */
function cardName(line: string): string {
  return line.replace(/^📍\s*/u, '').split(/\s+·\s+/)[0].trim();
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
export function generateVisualGuideCandidates(
  content: SocialContent,
  media: MediaEvidenceInput,
  bundle: EvidenceBundle
): RawPlaceCandidate[] {
  const frames = media.visionFrames || [];
  if (!['video', 'reel'].includes(content.contentType) || frames.length < 2) return [];

  const allText = [content.caption || '', ...frames.flatMap((frame) => frame.texts || [])].join('\n');
  const baseCategory = guideCategory(allText);
  const explicitGuideIntent = GUIDE_INTENT_RE.test(allText);
  const structuredEntries = new Set(
    frames.flatMap((frame) => (frame.texts || [])
      .filter((line) => STRUCTURED_VISUAL_ENTRY_RE.test(line))
      .map((line) => visualTextKey(cardName(line))))
      .filter(Boolean)
  ).size;
  // A normal review can have many OCR fragments, menu words and signs. Do not
  // reinterpret those fragments as venue cards unless the post is explicitly
  // framed as a guide or it contains at least three deliberate list/pin labels.
  if (!baseCategory || !VISUAL_GUIDE_RE.test(allText) || (!explicitGuideIntent && structuredEntries < MIN_VISUAL_CARDS)) return [];

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
    const sceneKeys = new Set((frame.sceneTexts || []).map(visualTextKey));
    const lines = [...new Set((frame.texts || []).map((line) => line.trim()).filter(Boolean))]
      .filter((line) => line.length >= 3 && !repeatedTitleKeys.has(visualTextKey(line)) && isCardLine(line, sceneKeys));
    // The guide cover contains category/headline text, not a venue card.
    if (lines.length === 0 || lines.some((line) => GUIDE_COVER_RE.test(line))) continue;

    // A pinned card carries the name on the marker ("📍 Buvette · 42 Grove St").
    // Otherwise venue cards use the final line for an area and the preceding
    // one or two lines for the display name ("THE PRIMO BY" + "MANN & SALWA").
    const pinned = lines.find((line) => /^📍/u.test(line));
    const nameLines = pinned ? [pinned] : lines.length > 1 ? lines.slice(0, -1) : lines;
    const name = (pinned ? cardName(pinned) : nameLines.join(' ')).replace(/\s+/g, ' ').trim();
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
  // A card guide shows a series of venue cards. One or two stray lines (a sign
  // behind the creator, a cup logo) are not a guide; the model call already
  // covers single labels.
  return candidates.length >= MIN_VISUAL_CARDS ? candidates : [];
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

        // Recovery: the list was cut off, or the evidence holds more street
        // addresses, pins or list entries than places returned. A places-only pass
        // is merged by entity; generated data is never trusted without the same
        // checks. Scene text (a billboard address, a street sign) does not count.
        const creatorItems = bundle.items.filter((item) => !item.scene);
        // Only creator-authored caption/comment text and explicit pins can
        // establish that a post contains several addresses. Raw OCR fragments
        // from a normal reel must not trigger a second extraction pass.
        const trustedLocationItems = creatorItems.filter((item) =>
          item.source === 'caption' ||
          item.source === 'comment_creator' ||
          ((item.source === 'ocr' || item.source === 'vision_ocr') && /^📍/u.test(item.text))
        );
        const sourceAddressCount = distinctSourceAddressCount(trustedLocationItems.map((item) => item.text));
        // Every 📍-marked line (any pin style, normalised) is a location the creator pointed at.
        const markedLocations = creatorItems.filter((item) => /^📍/u.test(item.text)).length;
        // Itinerary captions name their stops by @handle ("coffee from
        // @mochameltcafe", "pilates class at @togetherathletics"); each distinct
        // handle in the creator's own lines is a possible stop. Credits and
        // "follow" lines are not.
        const creatorHandle = content.authorUsername.replace(/^@/, '').toLowerCase();
        const captionHandles = new Set(bundle.items
          .filter((item) => (item.source === 'caption' || item.source === 'comment_creator') &&
            !/(?:📸|📷|🎥|📽|🎬|\bcredits?\b|\bcred\b|\bvia\b|\bfollow\b|\bshot by\b|\bfilmed by\b)/iu.test(item.text))
          .flatMap((item) => item.text.match(/@[\w.]{3,30}/g) || [])
          .map((handle) => handle.slice(1).replace(/\.$/, '').toLowerCase())
          .filter((handle) => handle !== creatorHandle));
        const listEntries = Math.max(captionHandles.size, countListEntries([
          bundle.items.filter((item) => item.source === 'caption').map((item) => item.text).join('\n'),
          ...bundle.items.filter((item) => item.source === 'comment_creator').map((item) => item.text),
        ]));
        // Videos: only cards accepted by the structured-guide gate count toward
        // recovery. Counting every OCR line creates a feedback loop on normal
        // reels and turns descriptions such as "iced" or "good" into places.
        // Carousels: the gate never runs on image slides, and designed slides
        // carry no subtitles, so each slide's label counts (an 8-card
        // Ahmedabad guide returned 5 places and no second look was taken).
        const isVideoPost = content.contentType === 'reel' || content.contentType === 'video';
        const screenCards = isVideoPost ? visualGuideCandidates.length : countScreenCards(media.visionFrames || []);
        const expected = Math.max(sourceAddressCount, markedLocations, screenCards);
        const listShortfall = listEntries * LIST_RECOVERY_RATIO > outcome.places.length;
        if (truncated || expected > outcome.places.length || listShortfall) {
          plog('model', 'Running places-only recovery pass', {
            truncated,
            sourceAddresses: sourceAddressCount,
            markedLocations,
            listEntries,
            screenCards,
            placesSoFar: outcome.places.length,
          }, 'warn');
          try {
            const found = outcome.places.map((place) => place.name).filter(Boolean).join(', ');
            const note = `CHECK: the evidence marks ${markedLocations} location(s) with 📍, ${sourceAddressCount} street address(es), ` +
              `${listEntries} list line(s) and ${screenCards} slide/scene label(s), ` +
              `but only ${outcome.places.length} place(s) were returned${found ? ` (${found})` : ''}. ` +
              'Follow the METHOD again and return EVERY place, including those already found.';
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

    // After every pass is merged: an entry that is another place's street
    // address ("331 West 4th Street" beside Corner Bistro at that address) is
    // that venue's address, not a separate place. Passes are checked
    // separately above, so an address returned by the recovery pass is only
    // caught here.
    // An entry named like a street address ("331 West 4th Street") on the same
    // slide or moment as a venue is that venue's address: it is attached to
    // the venue, so the map finds the venue at that address, and the entry is
    // dropped. The name must end in a street word, so venues whose names start
    // with a number ("11 Madison Park") are never taken for addresses.
    const framesOf = (place: PlaceExtraction) => new Set((place.evidence_ids || [])
      .flatMap((id) => bundle.byId.get(id)?.frames || []));
    for (const entry of outcome.places) {
      if (!ADDRESS_NAME_RE.test(entry.name || '') || !LocationService.sanitizeSourceAddress(entry.name || '')) continue;
      const entryFrames = framesOf(entry);
      const venue = outcome.places.find((other) => other !== entry && !other.address && !ADDRESS_NAME_RE.test(other.name || '') &&
        [...framesOf(other)].some((frame) => entryFrames.has(frame)));
      if (!venue) continue;
      plog('candidates', `"${entry.name}" is the address of "${venue.name}" (same slide or moment)`);
      venue.address = entry.name || '';
      entry.address = entry.name || '';
    }
    // The address step can attach the line to the entry itself, so only
    // other places' addresses are compared.
    const places = outcome.places.filter((place) => {
      const nameKey = collapseAlnum(place.name || '');
      const isOthersAddress = nameKey.length >= 5 &&
        outcome.places.some((other) => other !== place && collapseAlnum(other.address || '') === nameKey && collapseAlnum(other.name || '') !== nameKey);
      if (!isOthersAddress) return true;
      plog('candidates', `Rejected "${place.name}"`, { reason: "another place's street address" });
      outcome.rejected.push({ name: place.name || '', reason: "another place's street address" });
      return false;
    });
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
