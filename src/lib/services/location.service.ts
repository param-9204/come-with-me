type GeocodeResult = {
  lat: number | null;
  lng: number | null;
  formattedAddress: string | null;
  neighborhood: string | null;
  city: string | null;
};

type CityInfo = {
  name: string;
  country?: string;
};

type GoogleAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type GooglePlace = {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: GoogleAddressComponent[];
};

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

  private static namesMatch(expected: string, actual: string): boolean {
    const expectedName = this.normalize(expected);
    const actualName = this.normalize(actual);
    if (!expectedName || !actualName) return false;
    if (expectedName === actualName || expectedName.includes(actualName) || actualName.includes(expectedName)) return true;
    const compactExpected = expectedName.replace(/\s+/g, '');
    const compactActual = actualName.replace(/\s+/g, '');
    return compactExpected.length >= 5 && (
      compactExpected === compactActual ||
      compactExpected.includes(compactActual) ||
      compactActual.includes(compactExpected)
    );
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
    const aliases = Object.entries(CITY_ALIASES)
      .filter(([, info]) => info.name === canonicalCity)
      .map(([alias]) => alias);
    const cityWords = expectedCity.split(/[\s,]+/).filter((word) => word.length > 2);
    const normalizedAddress = this.normalize(address);
    return [canonicalCity, expectedCity, ...aliases, ...cityWords]
      .map((value) => this.normalize(value))
      .filter(Boolean)
      .some((value) => normalizedAddress.includes(value));
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

  private static async fetchGoogle(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private static async textSearch(query: string, apiKey: string, country?: string): Promise<GooglePlace[]> {
    const response = await this.fetchGoogle('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'en',
        pageSize: 20,
        ...(country ? { regionCode: country } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Google Places API returned HTTP ${response.status}`);
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
    };
  }

  private static async geocodeAddress(query: string, apiKey: string): Promise<GoogleGeocodeResult[]> {
    const params = new URLSearchParams({ address: query, key: apiKey, language: 'en' });
    const response = await this.fetchGoogle(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!response.ok) throw new Error(`Google Geocoding API returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Geocoding API returned ${data.status || 'an unknown status'}`);
    }
    return data.status === 'OK' && Array.isArray(data.results) ? data.results : [];
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
    // List headings such as "5 cozy restaurants" are commonly mangled by OCR
    // into a fake address like "5 cozy Street". Never use them to constrain a
    // provider lookup or satisfy the persistence address gate.
    if (/^\d{1,6}\s+(?:cozy|best|top|great|favorite|popular|new|nice|amazing|restaurants?|cafes?|bars?|places?|spots?)\b/i.test(address)) {
      return '';
    }
    return address;
  }

  static async geocodePlace(name: string, city: string, address?: string, neighborhood?: string): Promise<GeocodeResult> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      console.warn('[Geocoding] GOOGLE_MAPS_API_KEY is not configured.');
      return this.emptyResult();
    }

    const cleanName = name.trim();
    const suppliedAddress = address?.trim() || '';
    const cleanAddress = this.sanitizeSourceAddress(suppliedAddress);
    if (suppliedAddress && !cleanAddress) {
      console.warn(`[Geocoding] Ignoring non-address source text for "${name}": "${suppliedAddress}".`);
    }
    const cleanNeighborhood = neighborhood?.trim() || '';
    let cityInfo = this.cityInfo(city);
    if (!cityInfo.name && cleanAddress) cityInfo = this.cityInfo(this.detectCityFromText(cleanAddress));
    if (!cityInfo.name && (cleanName || cleanNeighborhood)) {
      cityInfo = this.cityInfo(this.detectCityFromText([cleanName, cleanNeighborhood].filter(Boolean).join(' ')));
    }
    if (!cleanName && !cleanAddress && !cityInfo.name && !cleanNeighborhood) return this.emptyResult();
    if (cleanAddress && !cityInfo.name) {
      console.warn(`[Geocoding] Refusing street-address lookup without city for "${cleanAddress}".`);
      return this.emptyResult();
    }

    const query = [cleanName, cleanAddress, cleanNeighborhood, cityInfo.name].filter(Boolean).join(', ').slice(0, 256);
    try {
      // Preserve the prior city-only behavior without treating an arbitrary
      // Places text-search result as a city centre.
      if (!cleanName && !cleanAddress && cityInfo.name) {
        const cityResults = await this.geocodeAddress(cityInfo.name, apiKey);
        const cityMatch = cityResults.find((result) =>
          this.cityMatches(cityInfo.name, [], result.formatted_address || '')
        );
        if (cityMatch) return this.geocodeResultFromAddress(cityMatch, cityInfo.name);
      }

      console.log(`[Geocoding] Trying Google Places text search for: "${query}"`);
      const places = await this.textSearch(query, apiKey, cityInfo.country);
      const matches = places.filter((place) => {
        const resultName = place.displayName?.text || '';
        const resultAddress = place.formattedAddress || '';
        const coordinates = place.location;
        const expectedCountryMatches = !cityInfo.country || !this.googlePlaceCountry(place) || this.googlePlaceCountry(place) === cityInfo.country;
        const neighborhoodMatches = !cleanNeighborhood || !this.googlePlaceNeighborhood(place) ||
          this.contextNamesMatch(cleanNeighborhood, [this.googlePlaceNeighborhood(place) || '']);
        const identityMatches = cleanName
          ? this.namesMatch(cleanName, resultName) || (!!cleanAddress && this.addressesMatch(cleanAddress, [resultAddress]))
          : cleanAddress
            ? this.addressesMatch(cleanAddress, [resultAddress])
            : true;
        return !!coordinates && Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude) &&
          expectedCountryMatches && identityMatches &&
          neighborhoodMatches &&
          this.addressesMatch(cleanAddress, [resultAddress, resultName]) &&
          this.cityMatches(cityInfo.name, [this.googlePlaceCity(place) || ''], resultAddress);
      });

      if (!cityInfo.name && !cleanAddress) {
        const exactMatches = matches.filter((place) => this.namesExactlyMatch(cleanName, place.displayName?.text || ''));
        const unique = new Map(exactMatches.map((place) => {
          const location = place.location!;
          return [`${location.latitude},${location.longitude}`, place];
        }));
        if (unique.size === 1) return this.resultFromPlace([...unique.values()][0]);
        console.warn(`[Geocoding] Name-only Google result for "${cleanName}" is ambiguous.`);
        return this.emptyResult();
      }

      if (matches.length > 0) {
        const match = matches[0];
        const result = this.resultFromPlace(match, cityInfo.name);
        console.log(`[Geocoding] Google Places verified match: ${result.formattedAddress} (${result.lat}, ${result.lng})`);
        return result;
      }

      // Google Geocoding resolves source-provided street addresses even when a
      // small venue is absent from the Places database.
      if (cleanAddress && cityInfo.name) {
        const addressQuery = [cleanAddress, cleanNeighborhood, cityInfo.name].filter(Boolean).join(', ');
        const addressResults = await this.geocodeAddress(addressQuery, apiKey);
        const addressMatch = addressResults.find((result) =>
          this.cityMatches(cityInfo.name, [], result.formatted_address || '') &&
          this.addressesMatch(cleanAddress, [result.formatted_address || ''])
        );
        if (addressMatch) {
          const result = this.geocodeResultFromAddress(addressMatch, cityInfo.name);
          console.log(`[Geocoding] Google address verified match: ${result.formattedAddress} (${result.lat}, ${result.lng})`);
          return result;
        }
      }
    } catch (error) {
      console.error('[Geocoding] Google Maps lookup failed:', error);
    }

    console.warn(`[Geocoding] No verified Google result for "${query}".`);
    return this.emptyResult();
  }

  static async getNeighborhood(lat: number, lng: number): Promise<string> {
    const apiKey = this.apiKey();
    if (!apiKey) return '';
    try {
      const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: apiKey, language: 'en' });
      const response = await this.fetchGoogle(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
      if (!response.ok) throw new Error(`Google Geocoding API returned HTTP ${response.status}`);
      const data = await response.json();
      for (const result of data.results || []) {
        for (const component of result.address_components || []) {
          if (component.types?.includes('neighborhood') || component.types?.includes('sublocality_level_2')) {
            return component.long_name || '';
          }
        }
      }
    } catch (error) {
      console.error('[Reverse Geocoding] Google failed:', error);
    }
    return '';
  }
}
