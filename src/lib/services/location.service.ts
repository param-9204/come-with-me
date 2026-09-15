type GeocodeResult = {
  lat: number | null;
  lng: number | null;
  formattedAddress: string | null;
  neighborhood: string | null;
};

type CityInfo = {
  name: string;
  country?: string;
};

const CITY_ALIASES: Record<string, CityInfo> = {
  nyc: { name: 'New York City', country: 'US' },
  'new york': { name: 'New York City', country: 'US' },
  'new york city': { name: 'New York City', country: 'US' },
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
    return { lat: null, lng: null, formattedAddress: null, neighborhood: null };
  }

  private static normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private static cityInfo(city: string): CityInfo {
    const cleaned = city.trim();
    return CITY_ALIASES[this.normalize(cleaned)] || { name: cleaned };
  }

  private static namesMatch(expected: string, actual: string): boolean {
    const expectedName = this.normalize(expected);
    const actualName = this.normalize(actual);
    return !!expectedName && (
      expectedName === actualName ||
      actualName.includes(expectedName) ||
      expectedName.includes(actualName)
    );
  }

  private static cityNamesMatch(expectedCity: string, candidateCities: string[]): boolean {
    if (!expectedCity.trim()) return true;
    const expected = this.normalize(this.cityInfo(expectedCity).name);
    return candidateCities.some(city => this.normalize(this.cityInfo(city).name) === expected);
  }

  private static addressContainsCity(address: string, expectedCity: string): boolean {
    if (!expectedCity.trim()) return true;
    const canonical = this.cityInfo(expectedCity).name;
    const variants = Object.entries(CITY_ALIASES)
      .filter(([, info]) => info.name === canonical)
      .map(([alias]) => alias);
    const normalizedAddress = this.normalize(address);
    return [canonical, ...variants].some(city => normalizedAddress.includes(this.normalize(city)));
  }

  static async geocodePlace(name: string, city: string, address?: string): Promise<GeocodeResult> {
    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;
    const cleanName = name.trim();
    const cleanAddress = address?.trim() || '';
    const cityInfo = this.cityInfo(city);

    if (!cleanName || (!cityInfo.name && !cleanAddress)) {
      return this.emptyResult();
    }

    const query = [cleanName, cleanAddress, cityInfo.name].filter(Boolean).join(', ').slice(0, 256);

    if (mapboxToken && mapboxToken !== 'your-mapbox-token') {
      try {
        const params = new URLSearchParams({
          q: query,
          access_token: mapboxToken,
          language: 'en',
          limit: '10',
          types: 'poi,address,place,city,locality,neighborhood',
          auto_complete: 'false',
          rank_strategy: 'relevance',
        });
        if (cityInfo.name) params.set('near', cityInfo.name);
        if (cityInfo.country) params.set('country', cityInfo.country);

        console.log(`[Geocoding] Trying Mapbox Search Box for: "${query}"`);
        const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${params}`);
        if (!res.ok) throw new Error(`Mapbox returned HTTP ${res.status}`);
        const data = await res.json();

        const match = (data.features || []).find((feature: any) => {
          const properties = feature.properties || {};
          const context = properties.context || {};
          const candidateCities = [
            properties.feature_type === 'city' || properties.feature_type === 'place' ? properties.name : '',
            context.place?.name,
            context.locality?.name,
            context.city?.name,
          ].filter(Boolean);
          const countryMatches = !cityInfo.country ||
            !context.country?.country_code ||
            context.country.country_code.toUpperCase() === cityInfo.country;
          const nameMatches = properties.feature_type === 'address' && cleanAddress
            ? true
            : this.namesMatch(cleanName, properties.name || '');

          return nameMatches && countryMatches && this.cityNamesMatch(cityInfo.name, candidateCities);
        });

        if (match) {
          const properties = match.properties;
          const [lng, lat] = match.geometry.coordinates;
          const formattedAddress = properties.full_address ||
            [properties.address, properties.place_formatted].filter(Boolean).join(', ') ||
            null;
          const neighborhood = properties.context?.neighborhood?.name ||
            properties.context?.locality?.name ||
            null;

          console.log(`[Geocoding] Mapbox verified match: ${formattedAddress} (${lat}, ${lng})`);
          return { lat, lng, formattedAddress, neighborhood };
        }

        console.warn(`[Geocoding] Mapbox returned no "${cityInfo.name}" match for: "${query}"`);
      } catch (err) {
        console.error('[Geocoding] Mapbox Search Box failed:', err);
      }
    }

    if (googleApiKey && googleApiKey !== 'your-google-places-api-key') {
      try {
        const params = new URLSearchParams({ query, key: googleApiKey });
        console.log(`[Geocoding] Trying Google Places text search for: "${query}"`);
        const res = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`);
        if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
        const data = await res.json();

        const match = (data.results || []).find((result: any) =>
          this.namesMatch(cleanName, result.name || '') &&
          this.addressContainsCity(result.formatted_address || '', cityInfo.name)
        );

        if (match) {
          const { lat, lng } = match.geometry.location;
          const neighborhood = await this.getNeighborhood(lat, lng);
          console.log(`[Geocoding] Google verified match: ${match.formatted_address} (${lat}, ${lng})`);
          return {
            lat,
            lng,
            formattedAddress: match.formatted_address || null,
            neighborhood: neighborhood || null,
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
