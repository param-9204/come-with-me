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

export class LocationService {
  private static emptyResult(): GeocodeResult {
    return { lat: null, lng: null, formattedAddress: null, neighborhood: null, city: null };
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
    if (!city) return '';
    let cleaned = city.trim();
    if (!cleaned) return '';

    // Strip details after comma if it looks like state/country (e.g. "Philadelphia, PA, USA" -> "Philadelphia")
    if (cleaned.includes(',')) {
      const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length > 0) {
        cleaned = parts[0];
      }
    }

    // Strip leading "City of ", "Town of ", "Borough of ", "Village of ", "County of ", "Municipality of ", "Township of "
    cleaned = cleaned.replace(/^(city|town|borough|village|county|municipality|township)\s+of\s+/i, '');

    // List of legitimate city names ending with "City"
    const legitCityNames = [
      'new york city', 'mexico city', 'salt lake city', 'kansas city', 'panama city',
      'quebec city', 'oklahoma city', 'guatemala city', 'ho chi minh city', 'carson city',
      'iowa city', 'jersey city', 'park city', 'dodge city', 'atlantic city', 'culver city',
      'studio city', 'rapid city', 'redwood city', 'traverse city', 'daly city', 'union city',
      'foster city', 'yuba city', 'cathedral city', 'sun city', 'universal city', 'city of industry'
    ];

    const norm = this.normalize(cleaned);

    // If it's a known alias in CITY_ALIASES, use that exact canonical city name!
    if (CITY_ALIASES[norm]) {
      return CITY_ALIASES[norm].name;
    }

    const isLegitCity = legitCityNames.includes(norm);

    if (!isLegitCity) {
      // Strip trailing " City", " city", " County", " county", " Township", " township", " Borough", " borough"
      cleaned = cleaned.replace(/\s+(city|county|township|borough|municipality)$/i, '');
    }

    const normAfter = this.normalize(cleaned);
    if (CITY_ALIASES[normAfter]) {
      return CITY_ALIASES[normAfter].name;
    }

    // Fix casing if it's ALL LOWERCASE or ALL UPPERCASE
    if (cleaned === cleaned.toLowerCase() || cleaned === cleaned.toUpperCase()) {
      cleaned = cleaned.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
    }

    return cleaned;
  }

  /**
   * Detect a canonical city from caption/OCR/mentions using known aliases only.
   * Uses word boundaries for normal prose. Collapsed handle matching is limited
   * to longer aliases (>=5) so short ones like "nola" do not match inside "granola".
   */
  static detectCityFromText(text: string | null | undefined): string {
    if (!text?.trim()) return '';

    const normalized = this.normalize(text);
    const handleTokens = (text.match(/[@#]?[A-Za-z][A-Za-z0-9._]{3,}/g) || [])
      .map((token) => token.replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((token) => token.length >= 4);

    const ranked = Object.entries(CITY_ALIASES)
      .map(([alias, info]) => ({ alias, info, len: alias.replace(/\s+/g, '').length }))
      .sort((a, b) => b.len - a.len);

    for (const { alias, info, len } of ranked) {
      const aliasCollapsed = alias.replace(/\s+/g, '');
      const tokenRe = new RegExp(`(?:^|\\s)${aliasCollapsed.replace(/\s+/g, '\\s+')}(?:\\s|$)`);
      if (tokenRe.test(normalized)) return info.name;

      // Handle/hashtag tokens only (e.g. oldcityphilly → philly). Require longer alias.
      if (len >= 5 && handleTokens.some((token) => token.includes(aliasCollapsed))) {
        return info.name;
      }
    }

    return '';
  }

  private static cityInfo(city: string): CityInfo {
    const cleaned = this.cleanCityName(city);
    const norm = this.normalize(cleaned);
    return CITY_ALIASES[norm] || { name: cleaned };
  }

  private static namesMatch(expected: string, actual: string): boolean {
    const expectedName = this.normalize(expected);
    const actualName = this.normalize(actual);
    if (!expectedName || !actualName) return false;
    if (
      expectedName === actualName ||
      actualName.includes(expectedName) ||
      expectedName.includes(actualName)
    ) {
      return true;
    }
    // Handles like "gaslamphotel" should match "Gas Lamp Hotel"
    const expectedCollapsed = expectedName.replace(/\s+/g, '');
    const actualCollapsed = actualName.replace(/\s+/g, '');
    return !!expectedCollapsed && (
      expectedCollapsed === actualCollapsed ||
      (expectedCollapsed.length >= 5 && actualCollapsed.includes(expectedCollapsed)) ||
      (actualCollapsed.length >= 5 && expectedCollapsed.includes(actualCollapsed))
    );
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

  private static addressesMatch(expectedAddress: string, candidateAddresses: string[]): boolean {
    if (!expectedAddress.trim()) return true;
    const expected = this.normalizeAddress(expectedAddress);
    if (!expected) return true;

    return candidateAddresses.some((candidate) => {
      const normalizedCandidate = this.normalizeAddress(candidate);
      return !!normalizedCandidate && (
        normalizedCandidate === expected ||
        normalizedCandidate.includes(expected) ||
        expected.includes(normalizedCandidate)
      );
    });
  }

  private static contextNamesMatch(expected: string, candidates: string[]): boolean {
    if (!expected.trim()) return true;
    const normalizedExpected = this.normalize(expected);
    return candidates.some((candidate) => {
      const normalizedCandidate = this.normalize(candidate);
      return !!normalizedCandidate && (
        normalizedCandidate === normalizedExpected ||
        normalizedCandidate.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedCandidate)
      );
    });
  }

  private static coordinatesFromFeature(feature: any): { lat: number; lng: number } | null {
    const geometryCoordinates = feature?.geometry?.coordinates;
    const propertiesCoordinates = feature?.properties?.coordinates;
    const lng = Array.isArray(geometryCoordinates)
      ? geometryCoordinates[0]
      : propertiesCoordinates?.longitude;
    const lat = Array.isArray(geometryCoordinates)
      ? geometryCoordinates[1]
      : propertiesCoordinates?.latitude;

    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  private static mapboxCity(properties: any): string | null {
    const context = properties?.context || {};
    const rawCity = (
      (['city', 'place', 'locality'].includes(properties?.feature_type) ? properties?.name : null) ||
      context.place?.name ||
      context.city?.name ||
      context.locality?.name ||
      null
    );
    return rawCity ? this.cleanCityName(rawCity) : null;
  }

  private static mapboxNeighborhood(properties: any): string | null {
    const context = properties?.context || {};
    return context.neighborhood?.name || context.locality?.name || null;
  }

  private static cityNamesMatch(expectedCity: string, candidateCities: string[]): boolean {
    if (!expectedCity.trim()) return true;
    const expectedCanonical = this.normalize(this.cityInfo(expectedCity).name);
    const expectedRaw = this.normalize(expectedCity);

    return candidateCities.some(city => {
      const normCity = this.normalize(city);
      const normCanonical = this.normalize(this.cityInfo(city).name);
      return (
        normCity === expectedCanonical ||
        normCanonical === expectedCanonical ||
        normCity === expectedRaw ||
        expectedRaw.includes(normCity) ||
        normCity.includes(expectedRaw)
      );
    });
  }

  private static addressContainsCity(address: string, expectedCity: string): boolean {
    if (!expectedCity.trim()) return true;
    const canonical = this.cityInfo(expectedCity).name;
    const variants = Object.entries(CITY_ALIASES)
      .filter(([, info]) => info.name === canonical)
      .map(([alias]) => alias);
    const rawParts = expectedCity.split(/[\s,]+/).map(p => this.normalize(p)).filter(p => p.length > 2);

    const normalizedAddress = this.normalize(address);
    const allKeywords = [canonical, expectedCity, ...variants, ...rawParts].map(k => this.normalize(k)).filter(Boolean);

    return allKeywords.some(keyword => normalizedAddress.includes(keyword));
  }

  static async geocodePlace(
    name: string,
    city: string,
    address?: string,
    neighborhood?: string
  ): Promise<GeocodeResult> {
    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;
    const cleanName = name.trim();
    const cleanAddress = address?.trim() || '';
    const cleanNeighborhood = neighborhood?.trim() || '';
    let cityInfo = this.cityInfo(city);

    // Street numbers without a city are globally ambiguous ("140 N 2nd St" exists
    // in many towns). Prefer detecting city from the address string itself before
    // refusing the lookup — never accept a random out-of-context match.
    if (!cityInfo.name && cleanAddress) {
      const detected = this.detectCityFromText(cleanAddress);
      if (detected) cityInfo = this.cityInfo(detected);
    }
    if (!cityInfo.name && (cleanName || cleanNeighborhood)) {
      const detected = this.detectCityFromText([cleanName, cleanNeighborhood].filter(Boolean).join(' '));
      if (detected) cityInfo = this.cityInfo(detected);
    }

    if (!cleanName && !cleanAddress && !cityInfo.name && !cleanNeighborhood) {
      return this.emptyResult();
    }

    if (cleanAddress && !cityInfo.name) {
      console.warn(
        `[Geocoding] Refusing street-address lookup without city for "${cleanAddress}" — ` +
        'ambiguous across many towns.'
      );
      return this.emptyResult();
    }

    const query = [cleanName, cleanAddress, cleanNeighborhood, cityInfo.name]
      .filter(Boolean)
      .join(', ')
      .slice(0, 256);
    const types = cleanName || cleanAddress ? 'poi,address' : 'city,place,locality';

    if (mapboxToken && mapboxToken !== 'your-mapbox-token') {
      try {
        const params = new URLSearchParams({
          q: query,
          access_token: mapboxToken,
          language: 'en',
          limit: '5',
          types,
          auto_complete: 'false',
        });
        const near = [cleanNeighborhood, cityInfo.name].filter(Boolean).join(', ');
        if (near) params.set('near', near);
        if (cityInfo.country) params.set('country', cityInfo.country);

        console.log(`[Geocoding] Trying Mapbox Search Box for: "${query}"`);
        const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${params}`);
        if (!res.ok) throw new Error(`Mapbox returned HTTP ${res.status}`);
        const data = await res.json();

        const match = (data.features || []).find((feature: any) => {
          const properties = feature.properties || {};
          const context = properties.context || {};
          const coordinates = this.coordinatesFromFeature(feature);
          if (!coordinates) return false;

          const candidateCities = [
            this.mapboxCity(properties),
            context.region?.name,
          ].filter((value): value is string => typeof value === 'string' && value.length > 0);
          const candidateNeighborhoods = [
            this.mapboxNeighborhood(properties),
            context.neighborhood?.name,
          ].filter((value): value is string => typeof value === 'string' && value.length > 0);
          const candidateAddresses = [
            properties.full_address,
            properties.address,
            properties.place_formatted,
            properties.name,
          ].filter((value): value is string => typeof value === 'string' && value.length > 0);
          const countryMatches = !cityInfo.country ||
            !context.country?.country_code ||
            context.country.country_code.toUpperCase() === cityInfo.country;

          // Primary: structured context fields. Fallback: city name appears
          // anywhere in the full_address or place_formatted string.
          const cityMatches = this.cityNamesMatch(cityInfo.name, candidateCities) ||
            candidateAddresses.some(addr => this.addressContainsCity(addr, cityInfo.name));

          const neighborhoodMatches = !cleanNeighborhood ||
            candidateNeighborhoods.length === 0 ||
            this.contextNamesMatch(cleanNeighborhood, candidateNeighborhoods);
          const nameMatches = cleanName
            ? this.namesMatch(cleanName, properties.name || '')
            : true;
          const addressMatches = this.addressesMatch(cleanAddress, candidateAddresses);
          const isAddressFallback = properties.feature_type === 'address' && !!cleanAddress && addressMatches;
          const identityMatches = cleanName
            ? nameMatches || isAddressFallback
            : cleanAddress
              ? addressMatches
              : this.namesMatch(cityInfo.name, properties.name || '');

          return identityMatches && addressMatches && cityMatches && neighborhoodMatches && countryMatches;
        });

        if (match) {
          const properties = match.properties;
          const coordinates = this.coordinatesFromFeature(match);
          if (!coordinates) return this.emptyResult();
          const formattedAddress = properties.full_address ||
            [properties.address, properties.place_formatted].filter(Boolean).join(', ') ||
            null;
          const resolvedNeighborhood = this.mapboxNeighborhood(properties);
          const resolvedCity = this.mapboxCity(properties);

          console.log(`[Geocoding] Mapbox verified match: ${formattedAddress} (${coordinates.lat}, ${coordinates.lng})`);
          return {
            lat: coordinates.lat,
            lng: coordinates.lng,
            formattedAddress,
            neighborhood: resolvedNeighborhood,
            city: resolvedCity,
          };
        }

        console.warn(`[Geocoding] Mapbox returned no "${cityInfo.name}" match for: "${query}"`);

        // Fallback: retry with address + city only (no POI name) — many small
        // businesses aren't in Mapbox's POI DB but their street address is.
        if (cleanAddress && cityInfo.name) {
          const addressQuery = [cleanAddress, cleanNeighborhood, cityInfo.name].filter(Boolean).join(', ');
          try {
            const fallbackParams = new URLSearchParams({
              q: addressQuery,
              access_token: mapboxToken,
              language: 'en',
              limit: '3',
              types: 'address,poi',
              auto_complete: 'false',
            });
            if (cityInfo.country) fallbackParams.set('country', cityInfo.country);
            console.log(`[Geocoding] Trying Mapbox address fallback for: "${addressQuery}"`);
            const fallbackRes = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${fallbackParams}`);
            if (fallbackRes.ok) {
              const fallbackData = await fallbackRes.json();
              const fallbackMatch = (fallbackData.features || []).find((feature: any) => {
                const coords = this.coordinatesFromFeature(feature);
                if (!coords) return false;
                const props = feature.properties || {};
                const fAddresses = [props.full_address, props.address, props.place_formatted, props.name]
                  .filter((v): v is string => typeof v === 'string' && v.length > 0);
                return fAddresses.some(addr => this.addressContainsCity(addr, cityInfo.name));
              });
              if (fallbackMatch) {
                const fbProps = fallbackMatch.properties || {};
                const fbCoords = this.coordinatesFromFeature(fallbackMatch)!;
                const fbAddress = fbProps.full_address ||
                  [fbProps.address, fbProps.place_formatted].filter(Boolean).join(', ') || null;
                console.log(`[Geocoding] Mapbox address fallback matched: ${fbAddress} (${fbCoords.lat}, ${fbCoords.lng})`);
                return {
                  lat: fbCoords.lat,
                  lng: fbCoords.lng,
                  formattedAddress: fbAddress,
                  neighborhood: this.mapboxNeighborhood(fbProps),
                  city: this.mapboxCity(fbProps) || cityInfo.name,
                };
              }
            }
          } catch (fbErr) {
            console.error('[Geocoding] Mapbox address fallback failed:', fbErr);
          }
        }
      } catch (err) {
        console.error('[Geocoding] Mapbox Search Box failed:', err);
      }

      // ── Mapbox Geocoding v5 (address resolution) ──────────────────────
      // The Search Box API above is optimised for POI autocomplete.
      // The v5 Geocoding API is better at resolving raw street addresses
      // like "140 N. 2nd Street, Philadelphia" to exact coordinates.
      if (cleanAddress || cleanName) {
        try {
          const v5Query = [cleanAddress || cleanName, cleanNeighborhood, cityInfo.name]
            .filter(Boolean)
            .join(', ');
          const v5Params = new URLSearchParams({
            access_token: mapboxToken,
            language: 'en',
            limit: '3',
            types: cleanAddress ? 'address,poi' : 'poi,place',
          });
          if (cityInfo.country) v5Params.set('country', cityInfo.country);

          console.log(`[Geocoding] Trying Mapbox Geocoding v5 for: "${v5Query}"`);
          const v5Res = await fetch(
            `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(v5Query)}.json?${v5Params}`
          );
          if (v5Res.ok) {
            const v5Data = await v5Res.json();
            const v5Match = (v5Data.features || []).find((feature: any) => {
              const coords = feature.geometry?.coordinates;
              if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return false;
              // Verify the result is in the expected city
              const placeName = feature.place_name || feature.text || '';
              const contextTexts = (feature.context || []).map((c: any) => c.text || '');
              const allTexts = [placeName, ...contextTexts];
              return !cityInfo.name || allTexts.some(t => this.addressContainsCity(t, cityInfo.name));
            });
            if (v5Match) {
              const [v5Lng, v5Lat] = v5Match.geometry.coordinates;
              const v5Address = v5Match.place_name || null;
              const v5Neighborhood = (v5Match.context || []).find(
                (c: any) => c.id?.startsWith('neighborhood') || c.id?.startsWith('locality')
              )?.text || null;
              const v5City = (v5Match.context || []).find(
                (c: any) => c.id?.startsWith('place') || c.id?.startsWith('district')
              )?.text || cityInfo.name;
              console.log(`[Geocoding] Mapbox v5 matched: ${v5Address} (${v5Lat}, ${v5Lng})`);
              return {
                lat: v5Lat,
                lng: v5Lng,
                formattedAddress: v5Address,
                neighborhood: v5Neighborhood,
                city: v5City,
              };
            }
            console.warn(`[Geocoding] Mapbox v5 returned no "${cityInfo.name}" match for: "${v5Query}"`);
          }
        } catch (v5Err) {
          console.error('[Geocoding] Mapbox Geocoding v5 failed:', v5Err);
        }
      }
    }

    // ── Google Places (last resort) ──────────────────────────────────────
    if (googleApiKey && googleApiKey !== 'your-google-places-api-key') {
      try {
        const params = new URLSearchParams({ query, key: googleApiKey });
        console.log(`[Geocoding] Trying Google Places text search for: "${query}"`);
        const res = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`);
        if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
        const data = await res.json();

        const match = (data.results || []).find((result: any) => {
          const resultAddress = result.formatted_address || '';
          const nameMatches = cleanName
            ? this.namesMatch(cleanName, result.name || '')
            : cleanAddress
              ? true
              : this.namesMatch(cityInfo.name, result.name || '');
          return nameMatches &&
            this.addressesMatch(cleanAddress, [resultAddress, result.name || '']) &&
            this.addressContainsCity(resultAddress, cityInfo.name);
        });

        if (match) {
          const { lat, lng } = match.geometry.location;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return this.emptyResult();
          const neighborhood = await this.getNeighborhood(lat, lng);
          console.log(`[Geocoding] Google verified match: ${match.formatted_address} (${lat}, ${lng})`);
          return {
            lat,
            lng,
            formattedAddress: match.formatted_address || null,
            neighborhood: neighborhood || null,
            city: cityInfo.name || null,
          };
        }

        console.warn(`[Geocoding] Google returned no "${cityInfo.name}" match for: "${query}"`);
      } catch (err) {
        console.error('[Geocoding] Google Places search failed:', err);
      }
    }

    console.warn(`[Geocoding] No verified result for "${query}"; refusing a conflicting location.`);
    return this.emptyResult();
  }

  static async getNeighborhood(lat: number, lng: number): Promise<string> {
    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (mapboxToken && mapboxToken !== 'your-mapbox-token') {
      try {
        const params = new URLSearchParams({
          access_token: mapboxToken,
          types: 'neighborhood,locality',
        });
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?${params}`
        );
        if (!res.ok) throw new Error(`Mapbox returned HTTP ${res.status}`);
        const data = await res.json();
        const neighborhood = (data.features || []).find(
          (feature: any) => feature.place_type?.includes('neighborhood')
        );
        return neighborhood?.text || data.features?.[0]?.text || '';
      } catch (err) {
        console.error('[Reverse Geocoding] Mapbox failed:', err);
      }
    }

    if (googleApiKey && googleApiKey !== 'your-google-places-api-key') {
      try {
        const params = new URLSearchParams({
          latlng: `${lat},${lng}`,
          key: googleApiKey,
        });
        const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
        if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
        const data = await res.json();

        for (const result of data.results || []) {
          for (const component of result.address_components || []) {
            if (component.types.includes('neighborhood') || component.types.includes('sublocality')) {
              return component.long_name;
            }
          }
        }
      } catch (err) {
        console.error('[Reverse Geocoding] Google failed:', err);
      }
    }

    return '';
  }
}
