import * as stringSimilarity from 'string-similarity';
import { plog, recordPipelineOperation } from './pipeline-log';
import { MapboxService, type MapboxFeature } from './mapbox.service';

export type GeocodeResult = {
  lat: number | null;
  lng: number | null;
  formattedAddress: string | null;
  neighborhood: string | null;
  city: string | null;
  /** Google Places id — stable key for deduplication across posts. */
  placeId?: string | null;
  primaryType?: string | null;
  types?: string[];
  /** Google's display name for the matched place. */
  matchedName?: string | null;
  /** Several same-name places matched in the same city and no address/neighbourhood narrowed it down. */
  ambiguous?: boolean;
  /** Which geocoder verified the result. */
  provider?: 'google' | 'mapbox';
  /** How strongly the provider result identifies the extracted place. */
  identity?: 'exact_name' | 'source_address' | 'fuzzy';
  /**
   * The post's spelling differs from the provider's only by OCR-style errors
   * or an abbreviation ("Greenwhich Vilage", "LES"); `matchedName` holds the
   * correct spelling ("Greenwich Village", "Lower East Side").
   */
  spellingCorrected?: boolean;
};

/**
 * What kind of place is being looked up. An area (neighbourhood, town) must
 * resolve to the area itself, never to a business whose name contains it
 * ("Greenwich Village" is not "Da Andrea Greenwich Village"); a venue must
 * never resolve to an area. Unknown kinds keep the default behaviour.
 */
export type PlaceKind = 'area' | 'venue' | 'street';

/** Provider result types that denote an area rather than a venue. */
const AREA_RESULT_TYPES = new Set([
  'neighborhood', 'sublocality', 'sublocality_level_1', 'sublocality_level_2', 'locality', 'postal_town',
  'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'colloquial_area',
]);

type NameMatch = { score: number; how: 'exact' | 'contains' | 'typo' | 'acronym' | 'fuzzy' };

const EUROPEAN_STREET_WORDS = 'rue|avenue|boulevard|bd|place|quai|all[ée]e|chemin|impasse|cours|via|viale|piazza|piazzale|corso|largo|calle|carrer|avenida|paseo|plaza|rua|travessa|strada';
/** "45 Rue Condorcet", "12 Via del Corso", "3 Place du Tertre". */
const EUROPEAN_NUMBER_FIRST_RE = new RegExp(String.raw`^\d{1,5}(?:\s?(?:bis|ter|[a-z]))?,?\s+(?:${EUROPEAN_STREET_WORDS})\.?\s+\p{L}`, 'iu');
/** "Calle de Serrano 41", "Carrer de Mallorca 401", "Hauptstraße 5". */
const EUROPEAN_NUMBER_LAST_RE = new RegExp(String.raw`^(?:(?:${EUROPEAN_STREET_WORDS})\.?\s+\p{L}.*|\p{L}+(?:straße|strasse|gasse|weg|platz|allee|straat|laan|gracht))\s\d{1,5}[a-z]?$`, 'iu');
/** Words that follow a number in prose or list headings, never a street name. */
const ADDRESS_COUNT_WORDS = new Set([
  'stars', 'days', 'nights', 'hours', 'hrs', 'minutes', 'mins', 'people', 'guests', 'reasons', 'spots', 'places', 'things',
  'ways', 'items', 'dollars', 'euros', 'bucks', 'percent', 'years', 'times', 'courses', 'dishes', 'restaurants', 'cafes',
  'bars', 'best', 'top', 'must', 'favorite', 'favourite', 'blocks', 'floors', 'stories', 'pieces', 'slices', 'tips', 'steps',
  'likes', 'followers', 'views', 'comments', 'guys', 'girls', 'friends', 'photos', 'min', 'km', 'miles', 'cozy', 'new',
]);

/**
 * Descriptor words that may differ between a creator's name for a venue and
 * Google's listing ("Katz's" vs "Katz's Delicatessen") without changing which
 * place it is. A non-descriptor extra word ("Joe's" vs "Joe's Shanghai") means
 * a different place.
 */
const NAME_DESCRIPTORS = new Set([
  'the', 'and', 'co', 'company', 'restaurant', 'restaurants', 'cafe', 'coffee', 'roasters', 'roastery', 'bar', 'pub',
  'bakery', 'bakehouse', 'kitchen', 'grill', 'pizzeria', 'pizza', 'deli', 'delicatessen', 'bistro', 'brasserie',
  'trattoria', 'taqueria', 'eatery', 'diner', 'shop', 'store', 'boutique', 'market', 'hotel', 'hostel', 'resort',
  'inn', 'museum', 'gallery', 'park', 'beach', 'club', 'lounge', 'rooftop', 'house', 'bbq', 'patisserie', 'tea',
  // Providers commonly append a venue type to an otherwise exact venue name
  // (for example, "Name - Cocktail Bar"). These identify the same venue, but
  // only in the existing exact-token containment check; they never make two
  // unrelated names match.
  'cocktail', 'wine', 'beer', 'spirits', 'taproom', 'tavern', 'gastropub',
  // Cuisine words listings add to the name a post uses: "Jajaja" is listed as
  // "Jajaja Mexicana", "Coletta" as "Coletta Italian Vegan Restaurant"
  // (both measured on Mapbox, 2026-09-25).
  'italian', 'italiana', 'italiano', 'mexican', 'mexicana', 'mexicano', 'thai', 'indian', 'chinese', 'szechuan', 'sichuan',
  'korean', 'japanese', 'vietnamese', 'mediterranean', 'ethiopian', 'lebanese', 'turkish', 'greek', 'french', 'spanish',
  'vegan', 'vegetarian', 'cuisine', 'cucina', 'food', 'foods', 'eats', 'cafe', 'caffe', 'boulangerie', 'dining',
  'room', 'studio', 'official', 'nyc', 'ny', 'la', 'sf', 'phl', 'philly', 'usa', 'uk', 'llc', 'inc',
  // Venue listings frequently add these legal/brand descriptors while captions
  // omit them: "Casa Carmen Winery" vs "Casa Carmen Farm and Winery".
  'farm', 'vineyard', 'winery', 'estate',
  // Articles: "GAZ" is "le gaz", "Mercerie" is "La Mercerie".
  'le', 'les', 'el', 'los', 'las', 'il', 'lo', 'die', 'der', 'das',
]);

type CityInfo = {
  name: string;
  country?: string;
};

type PreparedLookup = {
  cleanName: string;
  cleanAddress: string;
  cleanNeighborhood: string;
  cityInfo: CityInfo;
  /** Search text: only the place's own words from the post (name, its street address) plus its city. */
  query: string;
  kind?: PlaceKind;
};

type GoogleAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type GooglePlace = {
  /** Set on Mapbox results mapped into this shape. */
  provider?: 'google' | 'mapbox';
  id?: string;
  types?: string[];
  primaryType?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: GoogleAddressComponent[];
};

type ProviderPlace = GooglePlace;

type GoogleGeocodeResult = {
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  address_components?: Array<{
    long_name?: string;
    short_name?: string;
    types?: string[];
  }>;
};

const CITY_ALIASES: Record<string, CityInfo> = {
  nyc: { name: 'New York', country: 'US' },
  'new york': { name: 'New York', country: 'US' },
  'new york city': { name: 'New York', country: 'US' },
  brooklyn: { name: 'New York', country: 'US' },
  'brooklyn ny': { name: 'New York', country: 'US' },
  'brooklyn new york': { name: 'New York', country: 'US' },
  manhattan: { name: 'New York', country: 'US' },
  'manhattan ny': { name: 'New York', country: 'US' },
  queens: { name: 'New York', country: 'US' },
  bronx: { name: 'New York', country: 'US' },
  'staten island': { name: 'New York', country: 'US' },
  la: { name: 'Los Angeles', country: 'US' },
  'los angeles': { name: 'Los Angeles', country: 'US' },
  miami: { name: 'Miami', country: 'US' },
  chi: { name: 'Chicago', country: 'US' },
  chicago: { name: 'Chicago', country: 'US' },
  sf: { name: 'San Francisco', country: 'US' },
  'san francisco': { name: 'San Francisco', country: 'US' },
  dc: { name: 'Washington, DC', country: 'US' },
  washington: { name: 'Washington, DC', country: 'US' },
  'washington dc': { name: 'Washington, DC', country: 'US' },
  nola: { name: 'New Orleans', country: 'US' },
  'new orleans': { name: 'New Orleans', country: 'US' },
  atx: { name: 'Austin', country: 'US' },
  austin: { name: 'Austin', country: 'US' },
  philly: { name: 'Philadelphia', country: 'US' },
  phila: { name: 'Philadelphia', country: 'US' },
  philadelphia: { name: 'Philadelphia', country: 'US' },
  london: { name: 'London', country: 'GB' },
  delhi: { name: 'Delhi', country: 'IN' },
  'new delhi': { name: 'Delhi', country: 'IN' },
  bom: { name: 'Mumbai', country: 'IN' },
  bombay: { name: 'Mumbai', country: 'IN' },
  mumbai: { name: 'Mumbai', country: 'IN' },
  blr: { name: 'Bengaluru', country: 'IN' },
  bangalore: { name: 'Bengaluru', country: 'IN' },
  bengaluru: { name: 'Bengaluru', country: 'IN' },
};

/** Google Maps is the only geocoding provider used by this service. */
export class LocationService {
  private static emptyResult(): GeocodeResult {
    return { lat: null, lng: null, formattedAddress: null, neighborhood: null, city: null };
  }

  private static apiKey(): string | null {
    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
    return key && !key.startsWith('your-google-') ? key : null;
  }

  private static normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  static cleanCityName(city: string | null | undefined): string {
    if (!city?.trim()) return '';
    let cleaned = city.trim().split(',')[0].trim();
    cleaned = cleaned.replace(/^(city|town|borough|village|county|municipality|township)\s+of\s+/i, '');
    const normalized = this.normalize(cleaned);
    if (CITY_ALIASES[normalized]) return CITY_ALIASES[normalized].name;

    const legitimateCityNames = new Set([
      'new york city', 'mexico city', 'salt lake city', 'kansas city', 'panama city',
      'quebec city', 'oklahoma city', 'guatemala city', 'ho chi minh city', 'carson city',
      'iowa city', 'jersey city', 'park city', 'dodge city', 'atlantic city', 'culver city',
      'studio city', 'rapid city', 'redwood city', 'traverse city', 'daly city', 'union city',
      'foster city', 'yuba city', 'cathedral city', 'sun city', 'universal city', 'city of industry',
    ]);
    if (!legitimateCityNames.has(normalized)) {
      cleaned = cleaned.replace(/\s+(city|county|township|borough|municipality)$/i, '');
    }
    const normalizedAfterSuffixRemoval = this.normalize(cleaned);
    if (CITY_ALIASES[normalizedAfterSuffixRemoval]) return CITY_ALIASES[normalizedAfterSuffixRemoval].name;
    if (cleaned === cleaned.toLowerCase() || cleaned === cleaned.toUpperCase()) {
      cleaned = cleaned.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    }
    return cleaned;
  }

  static detectCityFromText(text: string | null | undefined): string {
    if (!text?.trim()) return '';
    const normalized = this.normalize(text);
    const handleTokens = (text.match(/[@#]?[A-Za-z][A-Za-z0-9._]{3,}/g) || [])
      .map((token) => token.replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((token) => token.length >= 4);
    const aliases = Object.entries(CITY_ALIASES)
      .map(([alias, info]) => ({ alias, info, length: alias.replace(/\s+/g, '').length }))
      .sort((a, b) => b.length - a.length);
    for (const { alias, info, length } of aliases) {
      const pattern = new RegExp(`(?:^|\\s)${alias.replace(/\s+/g, '\\s+')}(?:\\s|$)`);
      if (pattern.test(normalized)) return info.name;
      const compactAlias = alias.replace(/\s+/g, '');
      if (length >= 5 && handleTokens.some((token) => token.includes(compactAlias))) return info.name;
    }
    return '';
  }

  private static cityInfo(city: string): CityInfo {
    const cleaned = this.cleanCityName(city);
    return CITY_ALIASES[this.normalize(cleaned)] || { name: cleaned };
  }

  /**
   * 0–1 similarity between the extracted name and a Google display name.
   * Containment only counts when every extra word is a descriptor or part of
   * the query location, so "Joe's" does not match "Joe's Shanghai".
   */
  static nameSimilarity(expected: string, actual: string, locationWords: string[] = []): number {
    return this.nameMatch(expected, actual, locationWords).score;
  }

  /**
   * Name similarity plus how it matched. `typo` covers OCR letter errors
   * ("Greenwhich Vilage" = "Greenwich Village", "Joes Piza" = "Joe's Pizza"):
   * the names differ by at most 1 letter (6–11 letters) or 2 letters (12+),
   * and every number is identical, so "Pier 17" never matches "Pier 57".
   */
  private static nameMatch(expected: string, actual: string, locationWords: string[] = []): NameMatch {
    const expectedName = this.normalize(expected).replace(/\b(\w+) s\b/g, '$1s');
    const actualName = this.normalize(actual).replace(/\b(\w+) s\b/g, '$1s');
    if (!expectedName || !actualName) return { score: 0, how: 'fuzzy' };
    if (expectedName === actualName) return { score: 1, how: 'exact' };
    const compactExpected = expectedName.replace(/\s+/g, '');
    const compactActual = actualName.replace(/\s+/g, '');
    if (compactExpected === compactActual) return { score: 1, how: 'exact' };

    const locationTokens = new Set(locationWords.flatMap((word) => this.normalize(word).split(' ')).filter(Boolean));
    const allowed = new Set([...NAME_DESCRIPTORS, ...locationTokens]);
    const expectedTokens = expectedName.split(' ');
    const actualTokens = actualName.split(' ');
    // Singular and plural are the same word here: "Kati Rolls" = "The Kati Roll Company".
    const singular = (token: string) => (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
    const [shorter, longer] = (expectedTokens.length <= actualTokens.length ? [expectedTokens, actualTokens] : [actualTokens, expectedTokens])
      .map((tokens) => tokens.map(singular));
    const shorterCompact = shorter.join('');
    if (shorterCompact.length >= 3 && shorter.every((token) => longer.includes(token))) {
      // A place word may follow the name ("Benares Tribeca", "ilili NoMad")
      // but not precede it: "Astoria Soup Kitchen" is its own venue, not
      // "Soup Kitchen" in Astoria. Descriptor words may sit anywhere ("The
      // Kati Roll Company").
      const firstShared = longer.findIndex((token) => shorter.includes(token));
      const extrasOk = longer.every((token, index) => shorter.includes(token) ||
        NAME_DESCRIPTORS.has(token) || NAME_DESCRIPTORS.has(`${token}s`) ||
        ((locationTokens.has(token) || locationTokens.has(`${token}s`)) && index > firstShared));
      if (extrasOk) return { score: 0.92, how: 'contains' };
    }
    // Compact containment for handle-like names ("joespizza" vs "Joe's Pizza
    // Broadway"). The prefix must end on a whole word of the longer name, so a
    // word cut off by OCR ("West Villag") is handled as a misspelling below.
    const [shortC, longC] = compactExpected.length <= compactActual.length ? [compactExpected, compactActual] : [compactActual, compactExpected];
    const longTokens = shortC === compactExpected ? actualTokens : expectedTokens;
    const wordEnds = longTokens.reduce<number[]>((ends, token) => [...ends, (ends[ends.length - 1] || 0) + token.length], []);
    if (shortC.length >= 6 && longC.startsWith(shortC) && wordEnds.includes(shortC.length)) {
      const remainder = (shortC === compactExpected ? actualTokens : expectedTokens)
        .filter((token) => !shortC.includes(token));
      if (remainder.every((token) => allowed.has(token))) return { score: 0.9, how: 'contains' };
    }
    // OCR letter errors. Scored below exact and containment matches, so a
    // correctly spelled listing always wins over a near-spelling.
    if (this.isOcrMisspelling(compactExpected, compactActual)) return { score: 0.87, how: 'typo' };
    return { score: stringSimilarity.compareTwoStrings(expectedName, actualName), how: 'fuzzy' };
  }

  /** Same letters apart from a small number of OCR errors; numbers must be identical. */
  private static isOcrMisspelling(a: string, b: string): boolean {
    const digits = (value: string) => (value.match(/\d+/g) || []).join(' ');
    if (digits(a) !== digits(b)) return false;
    const length = Math.min(a.length, b.length);
    const budget = length >= 12 ? 2 : length >= 6 ? 1 : 0;
    if (budget === 0 || Math.abs(a.length - b.length) > budget) return false;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, current[j]);
      }
      if (rowMin > budget) return false;
      previous = current;
    }
    return previous[b.length] <= budget;
  }

  /**
   * "LES" = "Lower East Side", "UES" = "Upper East Side": the post's
   * all-capitals short form is the initials of the provider's name. Only
   * used for area results, where these abbreviations are standard.
   */
  private static isAcronymOf(expected: string, actual: string): boolean {
    const short = expected.trim();
    if (!/^[A-Z]{2,5}$/.test(short)) return false;
    const words = this.normalize(actual).split(' ').filter(Boolean);
    return words.length === short.length && words.map((word) => word[0]).join('') === short.toLowerCase();
  }

  private static isAreaResult(place: ProviderPlace): boolean {
    return (place.types || []).some((type) => AREA_RESULT_TYPES.has(type));
  }

  /** Lookup kind for an extracted category: areas and trips vs. businesses. */
  static kindForCategory(category: string | null | undefined): PlaceKind | undefined {
    const value = (category || '').toUpperCase();
    if (value === 'CITY' || value === 'TRAVEL') return 'area';
    if (['RESTAURANTS', 'COFFEE', 'BARS', 'NIGHTLIFE', 'SHOPPING'].includes(value)) return 'venue';
    return undefined;
  }

  private static namesExactlyMatch(expected: string, actual: string): boolean {
    return this.normalize(expected) === this.normalize(actual) && !!this.normalize(expected);
  }

  private static normalizeAddress(value: string): string {
    return this.normalize(value)
      .replace(/\b(st|str)\b/g, 'street')
      .replace(/\b(ave|av)\b/g, 'avenue')
      .replace(/\b(blvd)\b/g, 'boulevard')
      .replace(/\b(rd)\b/g, 'road')
      .replace(/\b(dr)\b/g, 'drive')
      .replace(/\b(ln)\b/g, 'lane')
      .replace(/\b(ct)\b/g, 'court')
      .replace(/\b(pl)\b/g, 'place')
      .replace(/\b(pkwy)\b/g, 'parkway')
      .replace(/\bn\b/g, 'north')
      .replace(/\bs\b/g, 'south')
      .replace(/\be\b/g, 'east')
      .replace(/\bw\b/g, 'west');
  }

  private static readonly STREET_SUFFIXES = new Set([
    'street', 'avenue', 'boulevard', 'road', 'drive', 'lane', 'court', 'place', 'parkway', 'way', 'terrace', 'highway', 'square', 'row',
  ]);

  /**
   * House number and street name of an address: "180 5th Ave, New York, NY
   * 10010" and "180 5th Avenue, New York City, New York 10010, United States"
   * both give 180 + "5th avenue". City, state, postcode and country spellings
   * differ between the post and each provider and are not compared here.
   */
  private static streetKey(value: string): { number: string; street: string[] } | null {
    const tokens = this.normalizeAddress(value.split(',')[0]).split(' ').filter(Boolean);
    const numberIndex = tokens.findIndex((token) => /^\d{1,6}[a-z]?$/.test(token));
    if (numberIndex < 0) return null;
    // "Calle de Serrano 41": the number follows the street.
    let street = numberIndex === tokens.length - 1 && numberIndex > 0
      ? tokens.slice(0, numberIndex)
      : tokens.slice(numberIndex + 1).filter((token) => !/^\d{5}$/.test(token));
    const suffixIndex = street.findIndex((token) => this.STREET_SUFFIXES.has(token));
    if (suffixIndex >= 0) street = street.slice(0, suffixIndex + 1);
    return street.length ? { number: tokens[numberIndex], street } : null;
  }

  private static addressesMatch(expected: string, candidates: string[]): boolean {
    if (!expected.trim()) return true;
    const normalizedExpected = this.normalizeAddress(expected);
    const expectedKey = this.streetKey(expected);
    return candidates.some((candidate) => {
      const candidateKey = expectedKey ? this.streetKey(candidate) : null;
      if (expectedKey && candidateKey) {
        // Same building number and street; one street spelling may be longer ("5th Avenue" / "5th Avenue Suite 2").
        const [shorter, longer] = expectedKey.street.length <= candidateKey.street.length
          ? [expectedKey.street, candidateKey.street] : [candidateKey.street, expectedKey.street];
        return expectedKey.number === candidateKey.number && shorter.every((token, index) => longer[index] === token);
      }
      const normalizedCandidate = this.normalizeAddress(candidate);
      return !!normalizedCandidate && (normalizedCandidate === normalizedExpected ||
        normalizedCandidate.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedCandidate));
    });
  }

  /** "Canal Street", "6th Ave", "Rue Condorcet", "Via del Corso": the name is itself a street. */
  static isStreetName(name: string): boolean {
    const value = name.trim();
    // "331 West 4th Street" is an address (a building), not the street itself.
    if (!value || /^\d{1,6}\s/.test(value) || /\d{1,6}\s+\S+.*,/.test(value)) return false;
    return /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|parkway|pkwy|terrace|highway|hwy)\.?$/i.test(value) ||
      /^(?:rue|calle|via|avenida|strada|chemin|quai|all[ée]e)\s+\S/i.test(value) ||
      /(?:straße|strasse|gasse|straat)$/i.test(value);
  }

  private static isStreetResult(place: ProviderPlace): boolean {
    return (place.types || []).some((type) => type === 'route' || type === 'street');
  }

  private static contextNamesMatch(expected: string, candidates: string[]): boolean {
    if (!expected.trim()) return true;
    const normalizedExpected = this.normalize(expected);
    return candidates.some((candidate) => {
      const normalizedCandidate = this.normalize(candidate);
      return !!normalizedCandidate && (normalizedCandidate === normalizedExpected ||
        normalizedCandidate.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedCandidate));
    });
  }

  private static addressContainsCity(address: string, expectedCity: string): boolean {
    if (!expectedCity.trim()) return true;
    const canonicalCity = this.cityInfo(expectedCity).name;
    // Whole names only. Matching single words let "New York" match
    // "Jersey City, New Jersey" (measured); 2–3 letter aliases (LA, SF, CHI)
    // are too short to find safely inside an address.
    const aliases = Object.entries(CITY_ALIASES)
      .filter(([alias, info]) => info.name === canonicalCity && alias.replace(/\s/g, '').length >= 4)
      .map(([alias]) => alias);
    const normalizedAddress = ` ${this.normalize(address)} `;
    return [canonicalCity, expectedCity, ...aliases]
      .map((value) => this.normalize(value))
      .filter(Boolean)
      .some((value) => normalizedAddress.includes(` ${value} `));
  }

  private static cityMatches(expected: string, actual: string[], address: string): boolean {
    if (!expected.trim()) return true;
    const expectedCanonical = this.normalize(this.cityInfo(expected).name);
    const componentMatches = actual.some((value) => {
      const normalizedValue = this.normalize(value);
      const canonicalValue = this.normalize(this.cityInfo(value).name);
      return normalizedValue === expectedCanonical || canonicalValue === expectedCanonical;
    });
    return componentMatches || this.addressContainsCity(address, expected);
  }

  private static componentValue(components: GoogleAddressComponent[], types: string[]): string | null {
    const component = components.find((item) => item.types?.some((type) => types.includes(type)));
    return component?.longText || component?.shortText || null;
  }

  private static googlePlaceCity(place: GooglePlace): string | null {
    const components = place.addressComponents || [];
    const city = this.componentValue(components, ['locality', 'postal_town', 'administrative_area_level_3']);
    return city ? this.cleanCityName(city) : null;
  }

  private static googlePlaceNeighborhood(place: GooglePlace): string | null {
    // `sublocality_level_1` is often a borough (for example, Manhattan), not
    // a neighbourhood (for example, West Village). Treating it as a precise
    // neighbourhood rejects otherwise exact Places Text Search matches.
    return this.componentValue(place.addressComponents || [], ['neighborhood', 'sublocality_level_2']);
  }

  private static googlePlaceCountry(place: GooglePlace): string | null {
    const country = (place.addressComponents || []).find((item) => item.types?.includes('country'));
    return country?.shortText?.toUpperCase() || country?.longText?.toUpperCase() || null;
  }

  private static distanceMeters(
    a: { latitude?: number; longitude?: number } | undefined,
    b: { latitude?: number; longitude?: number } | undefined
  ): number {
    if (!a || !b || !Number.isFinite(a.latitude) || !Number.isFinite(b.latitude)) return Infinity;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(b.latitude! - a.latitude!);
    const dLng = toRad(b.longitude! - a.longitude!);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude!)) * Math.cos(toRad(b.latitude!)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
  }

  private static async fetchGoogle(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Set when Google reports the project's daily Text Search quota as used up. */
  private static placesQuotaBlockedUntil = 0;

  static placesQuotaExhausted(): boolean {
    return Date.now() < this.placesQuotaBlockedUntil;
  }

  private static async textSearch(query: string, apiKey: string, country?: string): Promise<GooglePlace[]> {
    if (this.placesQuotaExhausted()) {
      throw Object.assign(new Error('Places API daily quota exhausted; skipping lookup until the quota resets.'), { status: 429, dailyQuota: true });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.textSearchOnce(query, apiKey, country);
      } catch (error: any) {
        if (error?.status !== 429) throw error;
        if (error.dailyQuota) {
          // Retrying a per-day limit cannot succeed: stop calling until the window resets.
          const resetMs = error.windowStart ? (Number(error.windowStart) + 86_400) * 1000 : Date.now() + 60 * 60_000;
          this.placesQuotaBlockedUntil = Math.max(resetMs, Date.now() + 60_000);
          plog('geocode', 'Google Places daily quota exhausted; lookups paused', {
            limitPerDay: error.quotaLimit ?? null,
            pausedUntil: new Date(this.placesQuotaBlockedUntil).toISOString(),
            fix: 'Raise "SearchTextRequest per day" in Google Cloud → IAM & Admin → Quotas',
          }, 'error');
          throw error;
        }
        // Per-minute quota is transient: retry twice, honouring Retry-After.
        if (attempt >= 2) throw error;
        const waitMs = Math.min(5_000, (Number(error.retryAfter) || 0) * 1000 || 1_000 * (attempt + 1));
        plog('geocode', 'Places API rate-limited (429); retrying', { waitMs, attempt: attempt + 1 }, 'warn');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  private static async textSearchOnce(query: string, apiKey: string, country?: string): Promise<GooglePlace[]> {
    const response = await this.fetchGoogle('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // id/types/primaryType enable place-id dedup and category verification.
        'X-Goog-FieldMask': 'places.id,places.types,places.primaryType,places.displayName,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'en',
        pageSize: 20,
        ...(country ? { regionCode: country } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as {
        error?: { message?: string; details?: Array<{ metadata?: Record<string, string> }> };
      };
      const quota = (body.error?.details || []).map((detail) => detail.metadata).find((meta) => meta?.quota_unit);
      throw Object.assign(new Error(`Google Places API returned HTTP ${response.status}: ${body.error?.message || ''}`.trim()), {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        dailyQuota: !!quota?.quota_unit?.includes('/d'),
        quotaLimit: quota?.quota_limit_value,
        windowStart: quota?.window_start_time,
      });
    }
    const data = await response.json();
    return Array.isArray(data.places) ? data.places : [];
  }

  private static resultFromPlace(place: GooglePlace, fallbackCity = ''): GeocodeResult {
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return this.emptyResult();
    return {
      lat: lat as number,
      lng: lng as number,
      formattedAddress: place.formattedAddress || null,
      city: this.googlePlaceCity(place) || this.cleanCityName(fallbackCity) || null,
      neighborhood: this.googlePlaceNeighborhood(place),
      // A Mapbox id must never be stored or used as a Google place id.
      placeId: place.provider === 'mapbox' ? null : place.id || null,
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types : [],
      matchedName: place.displayName?.text || null,
      provider: place.provider || 'google',
    };
  }

  /**
   * Resolve an indirect description ("horror bookstore Frankford Ave") only
   * when Google returns exactly one place in the stated city. Anything less
   * specific is treated as unknown rather than guessed.
   */
  static async findUniquePlace(query: string, city: string): Promise<{ name: string; city: string | null } | null> {
    const apiKey = this.apiKey();
    const cleanQuery = query.trim();
    const cityInfo = this.cityInfo(city || '');
    if (!apiKey || !cleanQuery || !cityInfo.name) return null;
    const textQuery = this.normalize(cleanQuery).includes(this.normalize(cityInfo.name)) ? cleanQuery : `${cleanQuery}, ${cityInfo.name}`;
    const places = (await this.textSearch(textQuery, apiKey, cityInfo.country)).filter((place) =>
      this.cityMatches(cityInfo.name, [this.googlePlaceCity(place) || ''], place.formattedAddress || '')
    );
    const unique = new Map(places.map((place) => [place.id || place.displayName?.text || '', place]));
    if (unique.size !== 1) {
      plog('geocode', 'Indirect description not resolved (needs exactly one match)', { query: textQuery, matches: unique.size });
      return null;
    }
    const [place] = [...unique.values()];
    return place.displayName?.text ? { name: place.displayName.text, city: this.googlePlaceCity(place) } : null;
  }

  /**
   * The Geocoding API is optional: Places Text Search (New) resolves cities,
   * neighbourhoods and street addresses with the same key. When Google reports
   * the Geocoding API as not enabled, skip it for a while instead of failing
   * every lookup.
   */
  private static geocodingDeniedUntil = 0;
  private static readonly GEOCODING_DENIED_BACKOFF_MS = 30 * 60_000;

  private static geocodingAvailable(): boolean {
    return Date.now() >= this.geocodingDeniedUntil;
  }

  private static async geocodeAddress(query: string, apiKey: string): Promise<GoogleGeocodeResult[]> {
    if (!this.geocodingAvailable()) return [];
    const params = new URLSearchParams({ address: query, key: apiKey, language: 'en' });
    const response = await this.fetchGoogle(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!response.ok) throw new Error(`Google Geocoding API returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.status === 'REQUEST_DENIED') {
      this.geocodingDeniedUntil = Date.now() + this.GEOCODING_DENIED_BACKOFF_MS;
      plog('geocode', 'Geocoding API unavailable; using Places Text Search only for 30 min', { reason: data.error_message || 'REQUEST_DENIED' }, 'warn');
      return [];
    }
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Geocoding API returned ${data.status || 'an unknown status'}`);
    }
    return data.status === 'OK' && Array.isArray(data.results) ? data.results : [];
  }

  /** Places result types that are areas (cities, neighbourhoods) rather than venues. */
  private static readonly AREA_TYPES = ['locality', 'postal_town', 'administrative_area_level_3', 'administrative_area_level_2', 'administrative_area_level_1', 'sublocality', 'sublocality_level_1', 'neighborhood'];
  private static readonly ADDRESS_TYPES = ['street_address', 'premise', 'subpremise', 'route'];

  /** City centre via Places Text Search (the result typed `locality` etc.), Geocoding API as fallback. */
  private static async lookupCity(cityInfo: CityInfo, apiKey: string): Promise<GeocodeResult | null> {
    const places = await this.textSearch(cityInfo.name, apiKey, cityInfo.country);
    const match = places.find((place) =>
      (place.types || []).some((type) => this.AREA_TYPES.includes(type)) &&
      this.cityMatches(cityInfo.name, [place.displayName?.text || '', this.googlePlaceCity(place) || ''], place.formattedAddress || '')
    );
    if (match) return { ...this.resultFromPlace(match, cityInfo.name), placeId: null, primaryType: null, types: [] };
    const cityResults = await this.geocodeAddress(cityInfo.name, apiKey);
    const cityMatch = cityResults.find((result) => this.cityMatches(cityInfo.name, [], result.formatted_address || ''));
    return cityMatch ? this.geocodeResultFromAddress(cityMatch, cityInfo.name) : null;
  }

  /**
   * Street address via Places Text Search (`street_address`/`premise`
   * results), Geocoding API as fallback. The address result's place id is
   * NOT returned: it identifies the building, and two venues can share one.
   */
  private static async lookupAddress(address: string, cityInfo: CityInfo, apiKey: string): Promise<GeocodeResult | null> {
    // The street address as written in the post, plus its city; no other words.
    const addressQuery = [address, cityInfo.name].filter(Boolean).join(', ');
    const places = await this.textSearch(addressQuery, apiKey, cityInfo.country);
    const match = places.find((place) =>
      (place.types || []).some((type) => this.ADDRESS_TYPES.includes(type)) &&
      this.cityMatches(cityInfo.name, [this.googlePlaceCity(place) || ''], place.formattedAddress || '') &&
      this.addressesMatch(address, [place.formattedAddress || ''])
    );
    if (match) return { ...this.resultFromPlace(match, cityInfo.name), placeId: null, primaryType: null, types: [], matchedName: null, identity: 'source_address' };
    const addressResults = await this.geocodeAddress(addressQuery, apiKey);
    const addressMatch = addressResults.find((result) =>
      this.cityMatches(cityInfo.name, [], result.formatted_address || '') &&
      this.addressesMatch(address, [result.formatted_address || ''])
    );
    return addressMatch ? { ...this.geocodeResultFromAddress(addressMatch, cityInfo.name), identity: 'source_address' } : null;
  }

  private static geocodeResultFromAddress(result: GoogleGeocodeResult, fallbackCity: string): GeocodeResult {
    const lat = result.geometry?.location?.lat;
    const lng = result.geometry?.location?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return this.emptyResult();
    const components = result.address_components || [];
    const read = (types: string[]) => components.find((item) => item.types?.some((type) => types.includes(type)))?.long_name || null;
    return {
      lat: lat as number,
      lng: lng as number,
      formattedAddress: result.formatted_address || null,
      city: this.cleanCityName(read(['locality', 'postal_town', 'administrative_area_level_3']) || fallbackCity) || null,
      neighborhood: read(['neighborhood', 'sublocality_level_2']),
    };
  }

  static sanitizeSourceAddress(value: string | null | undefined): string {
    const address = (value || '').trim().replace(/\s+/g, ' ');
    const streetLine = address.split(',')[0].trim();
    // Street-first languages: "45 Rue Condorcet", "12 Via del Corso",
    // "3 Place du Tertre", "Calle de Serrano 41", "Carrer de Mallorca 401".
    if (EUROPEAN_NUMBER_FIRST_RE.test(streetLine) || EUROPEAN_NUMBER_LAST_RE.test(streetLine)) return address;
    if (!/^\d{1,6}\s+\S+/.test(address)) return '';
    // Do not turn a founding year in prose ("Founded in 2017 by...") into a
    // fake street address. In particular, this must run before a downstream
    // short-address normalizer can append "Street" to `2017 by`.
    if (/^\d{4}\s+(?:by|in|from|for|with|was|were|is|are|founded|established|opened|created|built|since|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(address)) {
      return '';
    }
    // List headings such as "5 cozy restaurants" are commonly mangled by OCR
    // into a fake address like "5 cozy Street". Never use them to constrain a
    // provider lookup or satisfy the persistence address gate.
    if (/^\d{1,6}\s+(?:cozy|best|top|great|favorite|popular|new|nice|amazing|restaurants?|cafes?|bars?|places?|spots?)\b/i.test(address)) {
      return '';
    }
    // Do not let a sentence fragment such as "17 courses Street" or OCR noise
    // such as "10 we Street" constrain a good venue-name match. Source
    // addresses must contain a real road suffix and a plausible street-name
    // token after directions/unit labels are removed.
    if (!/\b(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|pkwy|parkway|wy|way|terrace|ter|highway|hwy|row|sq|square)\.?\b/i.test(address)) {
      // Streets written without a suffix are still addresses: a named street
      // ("1435 Broadway", "99 Bowery", "400 Ranstead") or a numbered one
      // ("140 N. 2nd"). The word after the number must be a capitalised name
      // or an ordinal, never a count ("5 Stars", "3 days", "10 not allowed").
      const tokens = streetLine.replace(/^\d{1,6}\s+/, '').replace(/^(?:n|s|e|w|north|south|east|west)\.?\s+/i, '').split(/\s+/);
      const word = (tokens[0] || '').replace(/[^\p{L}\p{N}'-]/gu, '');
      const ordinal = /^\d+(?:st|nd|rd|th)$/i.test(word);
      const properName = /^\p{Lu}[\p{L}'-]{2,}$/u.test(word) && !ADDRESS_COUNT_WORDS.has(word.toLowerCase());
      return ordinal || properName ? address : '';
    }
    const hasNumberedStreetName = /^\d{1,6}\s+(?:(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\.?\s+)?\d+(?:st|nd|rd|th)\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|pkwy|parkway|wy|way|terrace|ter|highway|hwy)\.?\b/i.test(address);
    const streetPart = address
      .replace(/^\d{1,6}\s+/i, '')
      .replace(/\b(?:apt|apartment|suite|ste|unit|floor|fl)\.?\s*#?\s*[\w-]+\b.*$/i, '')
      .replace(/\b(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\.?\b/gi, '')
      .replace(/\b\d+(?:st|nd|rd|th)\b/gi, '')
      .replace(/\b(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|pkwy|parkway|wy|way|terrace|ter|highway|hwy)\.?\b/gi, '')
      .replace(/[^a-z]/gi, ' ')
      .trim()
      .toLowerCase();
    // Prose around a number ("children under 10 not allowed") is not a street.
    const rejectedStreetWords = /\b(?:we|courses?|eats?|ways?|things?|restaurants?|cafes?|bars?|spots?|places?|best|top|favorite|must|not|under|allowed|kids|children|people|minutes?|mins?|hours?|years?)\b/i;
    if ((!streetPart && !hasNumberedStreetName) || rejectedStreetWords.test(streetPart)) return '';
    return address;
  }

  /** Google-shaped view of a Mapbox result, so both providers go through one verification path. */
  private static placeFromMapbox(feature: MapboxFeature): ProviderPlace {
    // Geocoding v6 areas carry a feature type instead of POI categories.
    const areaTypes: Record<string, string> = { neighborhood: 'neighborhood', locality: 'sublocality', place: 'locality', street: 'route' };
    const areaType = areaTypes[feature.featureType];
    const types = areaType === 'route'
      ? ['route']
      : areaType
        ? [areaType, 'political']
        : [...new Set(feature.categories.map((category) => category.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_')))];
    // Mapbox lists broad and specific categories together ("food", "french restaurant");
    // the longest non-generic one is the most specific.
    const primaryType = types
      .filter((type) => !['food', 'food_and_drink', 'shopping', 'services', 'point_of_interest', 'store', 'shop'].includes(type))
      .sort((a, b) => b.length - a.length)[0] || types[0];
    return {
      provider: 'mapbox',
      id: `mapbox:${feature.id}`,
      types,
      primaryType,
      displayName: { text: feature.name },
      formattedAddress: feature.fullAddress,
      location: { latitude: feature.lat, longitude: feature.lng },
      addressComponents: [
        ...(feature.place ? [{ longText: feature.place, types: ['locality'] }] : []),
        ...(feature.neighborhood ? [{ longText: feature.neighborhood, types: ['neighborhood'] }] : []),
        ...(feature.countryCode ? [{ shortText: feature.countryCode, longText: feature.countryCode, types: ['country'] }] : []),
      ],
    };
  }

  private static readonly mapboxCityCentres = new Map<string, [number, number] | null>();
  private static readonly mapboxCityBoxes = new Map<string, [number, number, number, number] | null>();

  /** City centre [lng, lat] for biasing Mapbox searches; cached per process with the city's bounding box. */
  private static async mapboxCityCentre(cityInfo: CityInfo): Promise<[number, number] | null> {
    if (!cityInfo.name) return null;
    const key = `${cityInfo.name}|${cityInfo.country || ''}`;
    if (this.mapboxCityCentres.has(key)) return this.mapboxCityCentres.get(key)!;
    const features = await MapboxService.geocode(cityInfo.name, 'place', { country: cityInfo.country });
    const match = features.find((feature) => this.cityMatches(cityInfo.name, [feature.name, feature.place || ''], feature.fullAddress));
    const centre: [number, number] | null = match ? [match.lng, match.lat] : null;
    this.mapboxCityCentres.set(key, centre);
    this.mapboxCityBoxes.set(key, match?.bbox || null);
    return centre;
  }

  /**
   * The city's bounding box, so Mapbox searches only inside it. Proximity
   * alone let same-name places elsewhere win: "Benares" returned a New Jersey
   * listing, "Benares Tribeca Indian Restaurant" only inside the NYC box
   * (measured 2026-09-25). Results are still checked against the city.
   */
  private static mapboxCityBox(cityInfo: CityInfo): [number, number, number, number] | null {
    return this.mapboxCityBoxes.get(`${cityInfo.name}|${cityInfo.country || ''}`) || null;
  }

  private static prepareLookup(name: string, city: string, address?: string, neighborhood?: string, kind?: PlaceKind): PreparedLookup | null {
    const cleanName = name.trim();
    const suppliedAddress = address?.trim() || '';
    const cleanAddress = this.sanitizeSourceAddress(suppliedAddress);
    if (suppliedAddress && !cleanAddress) {
      plog('geocode', 'Ignoring non-address text in the address field', { place: name, text: suppliedAddress }, 'warn');
    }
    const cleanNeighborhood = neighborhood?.trim() || '';
    let cityInfo = this.cityInfo(city);
    if (!cityInfo.name && cleanAddress) cityInfo = this.cityInfo(this.detectCityFromText(cleanAddress));
    if (!cityInfo.name && (cleanName || cleanNeighborhood)) {
      cityInfo = this.cityInfo(this.detectCityFromText([cleanName, cleanNeighborhood].filter(Boolean).join(' ')));
    }
    if (suppliedAddress && !cleanAddress && cleanName && cityInfo.name) {
      plog('geocode', 'Retrying with trusted venue name and city after rejecting the source address', {
        place: cleanName,
        city: cityInfo.name,
      }, 'warn');
    }
    if (!cleanName && !cleanAddress && !cityInfo.name && !cleanNeighborhood) return null;
    if (cleanAddress && !cityInfo.name) {
      plog('geocode', 'Street address without a city; not looked up', { place: name, address: cleanAddress }, 'warn');
      return null;
    }
    // The search text is the place's own text from the post, plus its city so
    // the provider looks in the right town. The neighbourhood is not added: it
    // often comes from a section heading rather than the place itself, and
    // extra words make providers return other businesses that contain them.
    // It is used only afterwards, to choose between same-name branches.
    const query = [cleanName, cleanAddress, cityInfo.name].filter(Boolean).join(', ').slice(0, 256);
    return { cleanName, cleanAddress, cleanNeighborhood, cityInfo, query, kind };
  }

  /**
   * Shared verification for Google and Mapbox results. A result is accepted
   * only when it is the place the post names: the name must match (exactly,
   * as a listing that adds only descriptor words, as an OCR misspelling, or
   * as an area abbreviation), and country, city, neighbourhood and street
   * address must agree. An area must not resolve to a venue and a venue must
   * not resolve to an area. Among accepted results the single highest name
   * similarity wins, with the provider's ranking breaking ties. The log keeps
   * only that result, or the closest result and why it was rejected.
   * Returns null when nothing verifies, an empty result when a name-only
   * lookup is ambiguous.
   */
  private static verifyCandidates(places: ProviderPlace[], lookup: PreparedLookup, providerLabel: string): GeocodeResult | null {
    const { cleanName, cleanAddress, cleanNeighborhood, cityInfo, query, kind } = lookup;
    const locationWords = [cityInfo.name, cleanNeighborhood].filter(Boolean);
    const scored = places.map((place, rank) => {
      const resultName = place.displayName?.text || '';
      const resultAddress = place.formattedAddress || '';
      const coordinates = place.location;
      const area = this.isAreaResult(place);
      const street = this.isStreetResult(place);
      // Words of the listing's own address and neighbourhood may appear in its
      // name ("Joe's Pizza Broadway" at 1435 Broadway, "Benares Tribeca" in
      // Tribeca) without changing identity. Street names compare with their
      // abbreviations expanded ("Canal St" = "Canal Street").
      const listingWords = [...locationWords, resultAddress, this.googlePlaceNeighborhood(place) || '', this.googlePlaceCity(place) || ''];
      let name: NameMatch = !cleanName
        ? { score: 0, how: 'fuzzy' }
        : kind === 'street'
          ? this.nameMatch(this.normalizeAddress(cleanName), this.normalizeAddress(resultName), listingWords)
          : this.nameMatch(cleanName, resultName, listingWords);
      if (cleanName && area && kind !== 'venue' && name.score < 0.85 && this.isAcronymOf(cleanName, resultName)) {
        name = { score: 0.9, how: 'acronym' };
      }
      const addressIdentity = !!cleanAddress && this.addressesMatch(cleanAddress, [resultAddress]);
      const identityMatches = cleanName ? name.score >= 0.85 || addressIdentity : cleanAddress ? addressIdentity : true;
      const country = this.googlePlaceCountry(place);
      const resultNeighborhood = this.googlePlaceNeighborhood(place);
      const reason: string | null =
        !coordinates || !Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude) ? 'no coordinates'
          : kind === 'venue' && area ? 'an area, not a venue'
            : kind === 'venue' && street ? 'a street, not a venue'
              : kind === 'street' && !street ? 'not the street itself (a business or stop on it)'
            : !identityMatches ? `name differs (similarity ${Math.round(name.score * 100) / 100})`
              : cityInfo.country && country && country !== cityInfo.country ? `different country (${country})`
                : !this.cityMatches(cityInfo.name, [this.googlePlaceCity(place) || ''], resultAddress) ? 'different city'
                  : cleanNeighborhood && resultNeighborhood && !this.contextNamesMatch(cleanNeighborhood, [resultNeighborhood])
                    ? `different neighbourhood (${resultNeighborhood})`
                    : !this.addressesMatch(cleanAddress, [resultAddress, resultName]) ? 'different street address'
                      : null;
      return { place, rank, name, addressIdentity, reason, similarity: addressIdentity ? Math.max(name.score, 0.9) : name.score };
    });
    type Scored = (typeof scored)[number];
    const summary = (entry: Scored) => ({
      name: entry.place.displayName?.text,
      address: entry.place.formattedAddress,
      type: entry.place.primaryType || entry.place.types?.[0],
      similarity: Math.round(entry.similarity * 100) / 100,
      match: entry.addressIdentity && entry.name.score < 0.85 ? 'street address' : entry.name.how,
    });
    const byScore = (a: Scored, b: Scored) => b.similarity - a.similarity || a.rank - b.rank;
    const matches = scored.filter((entry) => entry.reason === null).sort(byScore);
    const best = matches[0];
    if (best) {
      plog('geocode', `${providerLabel} search "${query}": chose "${best.place.displayName?.text || best.place.formattedAddress}"`, {
        results: places.length,
        chosen: summary(best),
      });
    } else {
      const closest = [...scored].sort(byScore)[0];
      plog('geocode', `${providerLabel} search "${query}": no match`, {
        results: places.length,
        ...(closest ? { closest: { ...summary(closest), rejected: closest.reason } } : {}),
      });
    }

    if (!cityInfo.name && !cleanAddress) {
      const exactMatches = matches.filter(({ place }) => this.namesExactlyMatch(cleanName, place.displayName?.text || ''));
      const unique = new Map(exactMatches.map(({ place }) => {
        const location = place.location!;
        return [`${location.latitude},${location.longitude}`, place];
      }));
      if (unique.size === 1) return { ...this.resultFromPlace([...unique.values()][0]), identity: 'exact_name' };
      plog('geocode', 'Name-only lookup is ambiguous (no city/address to choose between results)', { place: cleanName, exactMatches: unique.size, provider: providerLabel }, 'warn');
      return this.emptyResult();
    }

    if (!best) return null;
    const result = this.resultFromPlace(best.place, cityInfo.name);
    result.identity = best.name.how === 'exact' ? 'exact_name' : best.addressIdentity ? 'source_address' : 'fuzzy';
    result.spellingCorrected = best.name.how === 'typo' || best.name.how === 'acronym';
    if (best.addressIdentity && best.name.score < 0.6) {
      // Only the street address from the post matches: this is the right
      // building, but the listing may be another business in it. Keep the
      // coordinates and address; never adopt its id, name or type.
      Object.assign(result, { placeId: null, matchedName: null, primaryType: null, types: [], spellingCorrected: false });
    }
    // Chains: several near-identical names in the same city with nothing
    // (address/neighbourhood) to choose between them. Listings within
    // ~300 m are the same venue (box office, entrance), not branches.
    // Segments of one street are not branches.
    const peers = kind === 'street' ? [] : matches.filter((entry) =>
      entry.similarity >= best.similarity - 0.02 &&
      entry.place.id !== best.place.id &&
      this.distanceMeters(entry.place.location, best.place.location) > 300
    );
    result.ambiguous = !cleanAddress && !cleanNeighborhood && peers.length > 0;
    if (result.ambiguous) {
      plog('geocode', `"${cleanName}" has ${peers.length + 1} same-name branches in ${cityInfo.name}; kept the closest name match`, {
        provider: providerLabel,
        chosen: result.formattedAddress,
      }, 'warn');
    }
    return result;
  }

  /**
   * One Places Text Search per place, with the place's own text from the post
   * and its city. The same results are checked with the neighbourhood first
   * and then without it (it may describe the post's section, not the place),
   * so dropping it never costs another request. A street address from the
   * post is looked up only when no listing matched. Returns null when Google
   * found nothing verified or failed (quota, rate limit, network), so the
   * caller can fall back to Mapbox.
   */
  private static async geocodeWithGoogle(lookups: PreparedLookup[], apiKey: string): Promise<GeocodeResult | null> {
    const [first] = lookups;
    try {
      // City-only lookup (cities table): only an area-typed result counts as
      // the city centre, never an arbitrary venue in that city.
      if (!first.cleanName && !first.cleanAddress && first.cityInfo.name) return await this.lookupCity(first.cityInfo, apiKey);

      const places = (await this.textSearch(first.query, apiKey, first.cityInfo.country))
        .map((place) => ({ ...place, provider: 'google' as const }));
      for (const [index, lookup] of lookups.entries()) {
        const verified = this.verifyCandidates(places, lookup, index === 0 ? 'Google Maps' : 'Google Maps (without the neighbourhood)');
        if (verified) return verified;
      }

      // A source-provided street address still resolves when a small venue is
      // absent from the Places database.
      if (first.cleanAddress && first.cityInfo.name) {
        const result = await this.lookupAddress(first.cleanAddress, first.cityInfo, apiKey);
        if (result) {
          plog('geocode', 'Verified by street address on Google (venue not listed)', { place: first.cleanName, address: result.formattedAddress, lat: result.lat, lng: result.lng });
          return result;
        }
      }
    } catch (error) {
      // Quota errors are already reported once; avoid a stack trace per place.
      if ((error as { status?: number } | null)?.status === 429) plog('geocode', `Google skipped "${first.query}" (quota)`, { error: (error as Error).message }, 'warn');
      else plog('geocode', `Google lookup failed for "${first.query}"`, { error: (error as Error)?.message || String(error) }, 'error');
    }
    return null;
  }

  /** Mapbox business search, with one short retry when a burst of lookups returns nothing. */
  private static async mapboxPoiSearch(
    text: string,
    options: { proximity: [number, number] | null; country?: string; bbox?: [number, number, number, number] | null }
  ): Promise<MapboxFeature[]> {
    let features = await MapboxService.searchPoi(text, { ...options, limit: 10 });
    if (features.length === 0) {
      // Observed: identical requests intermittently return no results
      // during bursts of lookups. One short retry recovers those.
      await new Promise((resolve) => setTimeout(resolve, 500));
      features = await MapboxService.searchPoi(text, { ...options, limit: 10 });
      if (features.length > 0) plog('geocode', `Mapbox returned results for "${text}" on retry`, { results: features.length }, 'warn');
    }
    if (features.length === 0 && options.bbox) {
      // A misspelled name can match nothing inside the city box while the
      // wider search still finds the city's own listing. Results are still
      // checked against the city, so other towns cannot be accepted.
      features = await MapboxService.searchPoi(text, { ...options, bbox: null, limit: 10 });
    }
    return features;
  }

  /**
   * Mapbox, searched with the place's own name only. The city is a location
   * bias and a filter, never part of the text ("Brasserie Cognac New York"
   * matched JFK Airport). Areas go to the area geocoder first: the business
   * search can only return businesses whose names contain the area
   * ("Greenwich Village" → "Da Andrea Greenwich Village"). Each request is
   * sent once; the neighbourhood is only used to check the results.
   */
  private static async geocodeWithMapbox(lookups: PreparedLookup[]): Promise<GeocodeResult | null> {
    const [first] = lookups;
    const { cleanName, cleanAddress, cityInfo, kind } = first;
    try {
      const centre = await this.mapboxCityCentre(cityInfo);
      if (!cleanName && !cleanAddress && cityInfo.name) {
        return centre ? { ...this.emptyResult(), lat: centre[1], lng: centre[0], city: cityInfo.name, provider: 'mapbox' } : null;
      }
      if (cityInfo.name && !centre) {
        plog('geocode', `Mapbox could not locate the city "${cityInfo.name}"; skipping venue lookup`, undefined, 'warn');
        return null;
      }
      const options = { proximity: centre, country: cityInfo.country, bbox: this.mapboxCityBox(cityInfo) };
      const check = (features: MapboxFeature[], label: string, text: string): GeocodeResult | null => {
        const places = features.map((feature) => this.placeFromMapbox(feature));
        for (const [index, lookup] of lookups.entries()) {
          const verified = this.verifyCandidates(places, { ...lookup, query: text }, index === 0 ? label : `${label} (without the neighbourhood)`);
          if (verified) return verified;
        }
        return null;
      };

      // A street resolves to the street itself, never to a business or stop
      // named after it, so the business search is not used for streets.
      if (cleanName && kind === 'street') {
        return check(await MapboxService.geocodeStreet(cleanName, options), 'Mapbox streets', cleanName);
      }

      if (cleanName && kind === 'area') {
        const verified = check(await MapboxService.geocodeArea(cleanName, options), 'Mapbox areas', cleanName);
        if (verified) return verified;
      }

      let pois: MapboxFeature[] = [];
      if (cleanName) {
        pois = await this.mapboxPoiSearch(cleanName, options);
        const verified = check(pois, 'Mapbox', cleanName);
        if (verified) return verified;
      }

      // An OCR misspelling of an area the area geocoder did not recognise
      // ("Greenwhich Vilage"): the businesses found for the same text carry
      // the correctly spelled neighbourhood in Mapbox's own address data.
      // That spelling is looked up as an area once; nothing is guessed.
      if (cleanName && kind === 'area') {
        const spellings = [...new Set(pois.map((feature) => feature.neighborhood || ''))]
          .filter((spelling) => spelling && this.nameMatch(cleanName, spelling).how === 'typo')
          .slice(0, 2);
        for (const spelling of spellings) {
          plog('geocode', `Mapbox: looking up the area "${spelling}" for the misspelled "${cleanName}"`, undefined, 'warn');
          const verified = check(await MapboxService.geocodeArea(spelling, options), 'Mapbox areas', spelling);
          if (verified) return verified;
        }
      }

      if (cleanAddress && cityInfo.name) {
        const features = await MapboxService.geocode([cleanAddress, cityInfo.name].join(', '), 'address', options);
        const match = features.find((feature) =>
          this.cityMatches(cityInfo.name, [feature.place || '', feature.locality || ''], feature.fullAddress) &&
          this.addressesMatch(cleanAddress, [feature.fullAddress, feature.name])
        );
        if (match) {
          const result: GeocodeResult = {
            lat: match.lat,
            lng: match.lng,
            formattedAddress: match.fullAddress || null,
            city: this.cleanCityName(match.place || cityInfo.name) || null,
            neighborhood: match.neighborhood,
            placeId: null,
            primaryType: null,
            types: [],
            matchedName: null,
            provider: 'mapbox',
            identity: 'source_address',
          };
          plog('geocode', 'Verified by street address on Mapbox (venue not listed)', { place: cleanName, address: result.formattedAddress, lat: result.lat, lng: result.lng });
          return result;
        }
      }
    } catch (error) {
      plog('geocode', 'Mapbox lookup failed', { error: (error as Error)?.message || String(error) }, 'error');
    }
    return null;
  }

  /**
   * Resolve a place to verified coordinates. Google Places is tried first;
   * Mapbox only when Google is not configured, is over its daily quota,
   * fails, or finds no verified match. `kind` says whether the place is an
   * area (neighbourhood, town) or a venue, so each resolves to its own kind.
   */
  static async geocodePlace(
    name: string,
    city: string,
    address?: string,
    neighborhood?: string,
    options: { kind?: PlaceKind } = {}
  ): Promise<GeocodeResult> {
    const startedAt = new Date();
    const requestSummary = {
      name, city, hasAddress: Boolean(address?.trim()), hasNeighborhood: Boolean(neighborhood?.trim()), kind: options.kind || null,
    };
    const finish = (result: GeocodeResult, status: 'success' | 'partial' | 'skipped' = 'success'): GeocodeResult => {
      recordPipelineOperation({
        stage: 'geocode',
        operation: 'verify_place',
        provider: result.provider || null,
        model: result.provider === 'google' ? 'places-text-search' : result.provider === 'mapbox' ? 'search-geocoding' : null,
        status,
        startedAt,
        finishedAt: new Date(),
        requestSummary,
        resultSummary: {
          verified: result.lat !== null && result.lng !== null,
          ambiguous: Boolean(result.ambiguous),
          hasFormattedAddress: Boolean(result.formattedAddress),
          provider: result.provider || null,
          identity: result.identity || null,
          spellingCorrected: Boolean(result.spellingCorrected),
        },
      });
      return result;
    };
    // A name that is itself a street ("Canal Street", "Rue Condorcet") is
    // looked up as a street unless the post says it is a business.
    const kind: PlaceKind | undefined = options.kind !== 'venue' && this.isStreetName(name) ? 'street' : options.kind;
    requestSummary.kind = kind || null;
    const lookup = this.prepareLookup(name, city, address, neighborhood, kind);
    if (!lookup) return finish(this.emptyResult(), 'skipped');
    // The results are checked with the neighbourhood, then without it; the
    // city constraint still applies. Both use the same requests.
    const lookups = [lookup];
    if (lookup.cleanNeighborhood && lookup.cityInfo.name) lookups.push({ ...lookup, cleanNeighborhood: '' });
    const tried: string[] = [];

    const apiKey = this.apiKey();
    if (apiKey && !this.placesQuotaExhausted()) {
      tried.push('Google');
      const result = await this.geocodeWithGoogle(lookups, apiKey);
      if (result?.lat !== null && result?.lat !== undefined) return finish(result);
      if (result && lookup.cleanName && !lookup.cityInfo.name && !lookup.cleanAddress) return finish(result, 'partial'); // name-only ambiguity is final
    } else if (apiKey) {
      plog('geocode', `Google skipped for "${lookup.query}" (daily quota exhausted); using Mapbox`, undefined, 'warn');
    }

    if (MapboxService.isConfigured()) {
      tried.push('Mapbox');
      const result = await this.geocodeWithMapbox(lookups);
      if (result?.lat !== null && result?.lat !== undefined) return finish(result);
    }

    plog('geocode', `No verified result for "${lookup.query}"`, { tried: tried.length ? tried : ['none configured'] }, 'warn');
    return finish(this.emptyResult(), 'partial');
  }

  static async getNeighborhood(lat: number, lng: number): Promise<string> {
    const apiKey = this.apiKey();
    // Reverse geocoding needs the Geocoding API; Places results already carry
    // the neighbourhood when Google has one.
    if (!apiKey || !this.geocodingAvailable()) return '';
    try {
      const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: apiKey, language: 'en' });
      const response = await this.fetchGoogle(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
      if (!response.ok) throw new Error(`Google Geocoding API returned HTTP ${response.status}`);
      const data = await response.json();
      if (data.status === 'REQUEST_DENIED') {
        this.geocodingDeniedUntil = Date.now() + this.GEOCODING_DENIED_BACKOFF_MS;
        return '';
      }
      for (const result of data.results || []) {
        for (const component of result.address_components || []) {
          if (component.types?.includes('neighborhood') || component.types?.includes('sublocality_level_2')) {
            return component.long_name || '';
          }
        }
      }
    } catch (error) {
      plog('geocode', 'Reverse neighbourhood lookup failed', { error: (error as Error)?.message || String(error) }, 'warn');
    }
    return '';
  }
}
