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
  /** How strongly the provider result identifies the extracted venue. */
  identity?: 'exact_name' | 'source_address' | 'fuzzy';
};

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
  query: string;
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
    const expectedName = this.normalize(expected).replace(/\b(\w+) s\b/g, '$1s');
    const actualName = this.normalize(actual).replace(/\b(\w+) s\b/g, '$1s');
    if (!expectedName || !actualName) return 0;
    if (expectedName === actualName) return 1;
    const compactExpected = expectedName.replace(/\s+/g, '');
    const compactActual = actualName.replace(/\s+/g, '');
    if (compactExpected === compactActual) return 1;

    const allowed = new Set([...NAME_DESCRIPTORS, ...locationWords.flatMap((word) => this.normalize(word).split(' ')).filter(Boolean)]);
    const expectedTokens = expectedName.split(' ');
    const actualTokens = actualName.split(' ');
    const [shorter, longer] = expectedTokens.length <= actualTokens.length ? [expectedTokens, actualTokens] : [actualTokens, expectedTokens];
    const shorterCompact = shorter.join('');
    if (shorterCompact.length >= 3 && shorter.every((token) => longer.includes(token))) {
      const extras = longer.filter((token) => !shorter.includes(token));
      if (extras.every((token) => allowed.has(token))) return 0.92;
    }
    // Compact containment for handle-like names ("joespizza" vs "Joe's Pizza Broadway").
    const [shortC, longC] = compactExpected.length <= compactActual.length ? [compactExpected, compactActual] : [compactActual, compactExpected];
    if (shortC.length >= 6 && longC.startsWith(shortC)) {
      const remainder = (shortC === compactExpected ? actualTokens : expectedTokens)
        .filter((token) => !shortC.includes(token));
      if (remainder.every((token) => allowed.has(token))) return 0.9;
    }
    return stringSimilarity.compareTwoStrings(expectedName, actualName);
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

  private static addressesMatch(expected: string, candidates: string[]): boolean {
    if (!expected.trim()) return true;
    const normalizedExpected = this.normalizeAddress(expected);
    return candidates.some((candidate) => {
      const normalizedCandidate = this.normalizeAddress(candidate);
      return normalizedCandidate === normalizedExpected ||
        normalizedCandidate.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedCandidate);
    });
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
  private static async lookupAddress(address: string, neighborhood: string, cityInfo: CityInfo, apiKey: string): Promise<GeocodeResult | null> {
    const addressQuery = [address, neighborhood, cityInfo.name].filter(Boolean).join(', ');
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
    if (!/\b(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|pkwy|parkway|wy|way|terrace|ter|highway|hwy)\.?\b/i.test(address)) {
      return '';
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
    const types = [...new Set(feature.categories.map((category) => category.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_')))];
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

  /** City centre [lng, lat] for biasing Mapbox searches; cached per process. */
  private static async mapboxCityCentre(cityInfo: CityInfo): Promise<[number, number] | null> {
    if (!cityInfo.name) return null;
    const key = `${cityInfo.name}|${cityInfo.country || ''}`;
    if (this.mapboxCityCentres.has(key)) return this.mapboxCityCentres.get(key)!;
    const features = await MapboxService.geocode(cityInfo.name, 'place', { country: cityInfo.country });
    const match = features.find((feature) => this.cityMatches(cityInfo.name, [feature.name, feature.place || ''], feature.fullAddress));
    const centre: [number, number] | null = match ? [match.lng, match.lat] : null;
    this.mapboxCityCentres.set(key, centre);
    return centre;
  }

  private static prepareLookup(name: string, city: string, address?: string, neighborhood?: string): PreparedLookup | null {
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
    const query = [cleanName, cleanAddress, cleanNeighborhood, cityInfo.name].filter(Boolean).join(', ').slice(0, 256);
    return { cleanName, cleanAddress, cleanNeighborhood, cityInfo, query };
  }

  /**
   * Shared verification for Google and Mapbox results: name similarity,
   * country, city, neighbourhood and address must agree; the best name match
   * wins; chains with several distant same-name branches are flagged.
   * Returns null when nothing verifies, an empty result when a name-only
   * lookup is ambiguous.
   */
  private static verifyCandidates(places: ProviderPlace[], lookup: PreparedLookup, providerLabel: string): GeocodeResult | null {
    const { cleanName, cleanAddress, cleanNeighborhood, cityInfo, query } = lookup;
    const locationWords = [cityInfo.name, cleanNeighborhood].filter(Boolean);
    const scored = places.map((place, rank) => {
      const resultName = place.displayName?.text || '';
      const resultAddress = place.formattedAddress || '';
      const coordinates = place.location;
      const expectedCountryMatches = !cityInfo.country || !this.googlePlaceCountry(place) || this.googlePlaceCountry(place) === cityInfo.country;
      const neighborhoodMatches = !cleanNeighborhood || !this.googlePlaceNeighborhood(place) ||
        this.contextNamesMatch(cleanNeighborhood, [this.googlePlaceNeighborhood(place) || '']);
      // Words of the listing's own address may appear in its name
      // ("Joe's Pizza Broadway" at 1435 Broadway) without changing identity.
      const similarity = cleanName ? this.nameSimilarity(cleanName, resultName, [...locationWords, resultAddress]) : 0;
      const addressIdentity = !!cleanAddress && this.addressesMatch(cleanAddress, [resultAddress]);
      const identityMatches = cleanName
        ? similarity >= 0.85 || addressIdentity
        : cleanAddress
          ? addressIdentity
          : true;
      const valid = !!coordinates && Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude) &&
        expectedCountryMatches && identityMatches &&
        neighborhoodMatches &&
        this.addressesMatch(cleanAddress, [resultAddress, resultName]) &&
        this.cityMatches(cityInfo.name, [this.googlePlaceCity(place) || ''], resultAddress);
      return {
        place,
        rank,
        similarity: addressIdentity ? Math.max(similarity, 0.9) : similarity,
        valid,
        exactName: cleanName ? this.namesExactlyMatch(cleanName, resultName) : false,
        addressIdentity,
      };
    });
    // Best name similarity wins; the provider's own ranking breaks ties.
    const matches = scored.filter((entry) => entry.valid).sort((a, b) => b.similarity - a.similarity || a.rank - b.rank);
    plog('geocode', `${providerLabel} search "${query}"`, {
      results: places.length,
      verified: matches.length,
      top: scored.slice(0, 5).map((entry) => ({
        name: entry.place.displayName?.text,
        address: entry.place.formattedAddress,
        type: entry.place.primaryType,
        similarity: Math.round(entry.similarity * 100) / 100,
        accepted: entry.valid,
      })),
    });

    if (!cityInfo.name && !cleanAddress) {
      const exactMatches = matches.filter(({ place }) => this.namesExactlyMatch(cleanName, place.displayName?.text || ''));
      const unique = new Map(exactMatches.map(({ place }) => {
        const location = place.location!;
        return [`${location.latitude},${location.longitude}`, place];
      }));
      if (unique.size === 1) return this.resultFromPlace([...unique.values()][0]);
      plog('geocode', 'Name-only lookup is ambiguous (no city/address to choose between results)', { place: cleanName, exactMatches: unique.size, provider: providerLabel }, 'warn');
      return this.emptyResult();
    }

    if (matches.length === 0) return null;
    const best = matches[0];
    const result = this.resultFromPlace(best.place, cityInfo.name);
    result.identity = best.exactName ? 'exact_name' : best.addressIdentity ? 'source_address' : 'fuzzy';
    // Chains: several near-identical names in the same city with nothing
    // (address/neighbourhood) to choose between them. Listings within
    // ~300 m are the same venue (box office, entrance), not branches.
    const peers = matches.filter((entry) =>
      entry.similarity >= best.similarity - 0.02 &&
      entry.place.id !== best.place.id &&
      this.distanceMeters(entry.place.location, best.place.location) > 300
    );
    result.ambiguous = !cleanAddress && !cleanNeighborhood && peers.length > 0;
    plog('geocode', `Verified "${cleanName || cleanAddress}" on ${providerLabel}`, {
      name: result.matchedName,
      address: result.formattedAddress,
      lat: result.lat,
      lng: result.lng,
      placeId: result.placeId,
      type: result.primaryType,
      similarity: Math.round(best.similarity * 100) / 100,
      ...(result.ambiguous ? { ambiguousBranches: peers.length + 1 } : {}),
    }, result.ambiguous ? 'warn' : 'info');
    return result;
  }

  /**
   * Google Places for every lookup variant, in order, until one verifies.
   * Before a looser variant (no neighbourhood) spends another request, the
   * results already fetched are checked against it: the venue is often in them
   * and was only rejected for a neighbourhood that came from the post's
   * context. Returns null when Google found nothing verified or failed
   * (quota, rate limit, network), so the caller can fall back to Mapbox.
   */
  private static async geocodeWithGoogle(lookups: PreparedLookup[], apiKey: string): Promise<GeocodeResult | null> {
    const [first] = lookups;
    let current = first;
    try {
      // City-only lookup (cities table): only an area-typed result counts as
      // the city centre, never an arbitrary venue in that city.
      if (!first.cleanName && !first.cleanAddress && first.cityInfo.name) return await this.lookupCity(first.cityInfo, apiKey);

      let fetched: ProviderPlace[] | null = null;
      for (const lookup of lookups) {
        current = lookup;
        if (fetched) {
          plog('geocode', `Retrying "${lookup.cleanName}" on Google without the neighbourhood "${first.cleanNeighborhood}"`, undefined, 'warn');
          const reused = this.verifyCandidates(fetched, lookup, 'Google Maps (same results)');
          if (reused) return reused;
        }
        const places = await this.textSearch(lookup.query, apiKey, lookup.cityInfo.country);
        fetched = places.map((place) => ({ ...place, provider: 'google' as const }));
        const verified = this.verifyCandidates(fetched, lookup, 'Google Maps');
        if (verified) return verified;

        // A source-provided street address still resolves when a small venue is
        // absent from the Places database.
        if (lookup.cleanAddress && lookup.cityInfo.name) {
          const result = await this.lookupAddress(lookup.cleanAddress, lookup.cleanNeighborhood, lookup.cityInfo, apiKey);
          if (result) {
            plog('geocode', 'Verified by street address on Google (venue not listed)', { place: lookup.cleanName, address: result.formattedAddress, lat: result.lat, lng: result.lng });
            return result;
          }
        }
      }
    } catch (error) {
      // Quota errors are already reported once; avoid a stack trace per place.
      if ((error as { status?: number } | null)?.status === 429) plog('geocode', `Google skipped "${current.query}" (quota)`, { error: (error as Error).message }, 'warn');
      else plog('geocode', `Google lookup failed for "${current.query}"`, { error: (error as Error)?.message || String(error) }, 'error');
    }
    return null;
  }

  /**
   * Mapbox for every lookup variant, in order, until one verifies. Identical
   * searches are sent once per call: the name-only query is the same with or
   * without a neighbourhood, so the looser variant re-checks those results.
   */
  private static async geocodeWithMapbox(lookups: PreparedLookup[]): Promise<GeocodeResult | null> {
    const searches = new Map<string, Promise<MapboxFeature[]>>();
    const searchPoi = (text: string, centre: [number, number] | null, country?: string) => {
      if (!searches.has(text)) {
        searches.set(text, (async () => {
          let features = await MapboxService.searchPoi(text, { proximity: centre, country, limit: 10 });
          if (features.length === 0) {
            // Observed: identical requests intermittently return no results
            // during bursts of lookups. One short retry recovers those.
            await new Promise((resolve) => setTimeout(resolve, 500));
            features = await MapboxService.searchPoi(text, { proximity: centre, country, limit: 10 });
            if (features.length > 0) plog('geocode', `Mapbox returned results for "${text}" on retry`, { results: features.length }, 'warn');
          }
          return features;
        })());
      }
      return searches.get(text)!;
    };

    for (const [index, lookup] of lookups.entries()) {
      if (index > 0) plog('geocode', `Retrying "${lookup.cleanName}" on Mapbox without the neighbourhood "${lookups[0].cleanNeighborhood}"`, undefined, 'warn');
      const result = await this.geocodeWithMapboxLookup(lookup, searchPoi);
      if (result?.lat !== null && result?.lat !== undefined) return result;
    }
    return null;
  }

  private static async geocodeWithMapboxLookup(
    lookup: PreparedLookup,
    searchPoi: (text: string, centre: [number, number] | null, country?: string) => Promise<MapboxFeature[]>
  ): Promise<GeocodeResult | null> {
    const { cleanName, cleanAddress, cleanNeighborhood, cityInfo } = lookup;
    try {
      const centre = await this.mapboxCityCentre(cityInfo);
      if (!cleanName && !cleanAddress && cityInfo.name) {
        return centre ? { ...this.emptyResult(), lat: centre[1], lng: centre[0], city: cityInfo.name, provider: 'mapbox' } : null;
      }
      if (cityInfo.name && !centre) {
        plog('geocode', `Mapbox could not locate the city "${cityInfo.name}"; skipping venue lookup`, undefined, 'warn');
        return null;
      }

      if (cleanName) {
        // Name only, biased to the city centre. Adding the city to the text
        // makes Mapbox match the city words instead (measured: "Brasserie
        // Cognac New York" → JFK Airport; "Brasserie Cognac" → both branches).
        const queries = [cleanName, cleanNeighborhood ? `${cleanName} ${cleanNeighborhood}` : ''].filter(Boolean);
        for (const text of queries) {
          const features = await searchPoi(text, centre, cityInfo.country);
          const verified = this.verifyCandidates(features.map((feature) => this.placeFromMapbox(feature)), { ...lookup, query: text }, 'Mapbox');
          if (verified) return verified;
        }
      }

      if (cleanAddress && cityInfo.name) {
        const features = await MapboxService.geocode(
          [cleanAddress, cleanNeighborhood, cityInfo.name].filter(Boolean).join(', '),
          'address',
          { proximity: centre, country: cityInfo.country }
        );
        const match = features.find((feature) =>
          this.cityMatches(cityInfo.name, [feature.place || '', feature.locality || ''], feature.fullAddress) &&
          this.addressesMatch(cleanAddress, [feature.fullAddress, feature.name]) &&
          (!cleanNeighborhood || !feature.neighborhood || this.contextNamesMatch(cleanNeighborhood, [feature.neighborhood]))
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
   * Resolve a place to verified coordinates. Google Places is tried first and
   * fully: the lookup as given, then without a neighbourhood that may have
   * come from the post's context ("Day 3 - Dumbo" before a pizzeria elsewhere).
   * Mapbox is called only when Google is not configured, is over its daily
   * quota, fails, or finds no verified match.
   */
  static async geocodePlace(name: string, city: string, address?: string, neighborhood?: string): Promise<GeocodeResult> {
    const startedAt = new Date();
    const requestSummary = { name, city, hasAddress: Boolean(address?.trim()), hasNeighborhood: Boolean(neighborhood?.trim()) };
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
        },
      });
      return result;
    };
    const lookup = this.prepareLookup(name, city, address, neighborhood);
    if (!lookup) return finish(this.emptyResult(), 'skipped');
    // The same lookup without the neighbourhood; the city constraint still applies.
    const lookups = [lookup];
    if (lookup.cleanNeighborhood && lookup.cityInfo.name) {
      lookups.push({
        ...lookup,
        cleanNeighborhood: '',
        query: [lookup.cleanName, lookup.cleanAddress, lookup.cityInfo.name].filter(Boolean).join(', ').slice(0, 256),
      });
    }
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
