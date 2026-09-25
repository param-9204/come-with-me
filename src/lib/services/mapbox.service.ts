import { plog } from './pipeline-log';

/** A Mapbox result normalised from the Search Box API (POIs) or Geocoding v6 (places, addresses). */
export interface MapboxFeature {
  id: string;
  name: string;
  fullAddress: string;
  lat: number;
  lng: number;
  featureType: string;
  categories: string[];
  place: string | null;
  locality: string | null;
  neighborhood: string | null;
  countryCode: string | null;
  /** [minLng, minLat, maxLng, maxLat]; present on places (cities) from Geocoding v6. */
  bbox?: [number, number, number, number] | null;
}

interface SearchOptions {
  /** [lng, lat] — Mapbox ranks results near this point first. Without it, global results win ("Mei Lah Wah" → UK). */
  proximity?: [number, number] | null;
  /** ISO 3166-1 alpha-2, lower-case. */
  country?: string | null;
  /** [minLng, minLat, maxLng, maxLat]: only results inside this box. */
  bbox?: [number, number, number, number] | null;
  limit?: number;
}

const SEARCH_BOX_URL = 'https://api.mapbox.com/search/searchbox/v1/forward';
const GEOCODING_V6_URL = 'https://api.mapbox.com/search/geocode/v6/forward';
const TIMEOUT_MS = 15_000;

function contextName(context: any, key: string): string | null {
  const value = context?.[key];
  return typeof value?.name === 'string' && value.name.trim() ? value.name.trim() : null;
}

function parseFeature(feature: any): MapboxFeature | null {
  const properties = feature?.properties || {};
  const lat = properties.coordinates?.latitude ?? feature?.geometry?.coordinates?.[1];
  const lng = properties.coordinates?.longitude ?? feature?.geometry?.coordinates?.[0];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const context = properties.context || {};
  return {
    id: String(properties.mapbox_id || feature?.id || `${lat},${lng}`),
    name: String(properties.name || properties.name_preferred || ''),
    fullAddress: String(properties.full_address || properties.place_formatted || ''),
    lat,
    lng,
    featureType: String(properties.feature_type || ''),
    categories: Array.isArray(properties.poi_category) ? properties.poi_category.map(String) : [],
    place: contextName(context, 'place'),
    locality: contextName(context, 'locality'),
    neighborhood: contextName(context, 'neighborhood'),
    countryCode: typeof context.country?.country_code === 'string' ? context.country.country_code.toUpperCase() : null,
    bbox: Array.isArray(properties.bbox) && properties.bbox.length === 4 && properties.bbox.every(Number.isFinite)
      ? properties.bbox as [number, number, number, number]
      : null,
  };
}

/**
 * Mapbox geocoding, used when Google Places is not configured, out of quota,
 * or finds no verified match. Every result still goes through the same
 * name / city / address checks as Google results.
 */
export class MapboxService {
  private static unavailableUntil = 0;
  private static readonly UNAVAILABLE_BACKOFF_MS = 10 * 60_000;

  static token(): string | null {
    const token = (process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '').trim();
    return token && !token.startsWith('your-') ? token : null;
  }

  static isConfigured(): boolean {
    return !!this.token() && Date.now() >= this.unavailableUntil;
  }

  private static async request(baseUrl: string, params: Record<string, string>): Promise<MapboxFeature[]> {
    const token = this.token();
    if (!token || !this.isConfigured()) return [];
    const url = `${baseUrl}?${new URLSearchParams({ ...params, access_token: token })}`;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 401 || response.status === 403) {
        this.unavailableUntil = Date.now() + this.UNAVAILABLE_BACKOFF_MS;
        const body = await response.json().catch(() => ({}));
        plog('geocode', 'Mapbox rejected the token; Mapbox lookups paused for 10 min', { status: response.status, message: body?.message }, 'error');
        return [];
      }
      if (response.status === 429 && attempt < 2) {
        const waitMs = Math.min(5_000, (Number(response.headers.get('retry-after')) || 0) * 1000 || 1_000 * (attempt + 1));
        plog('geocode', 'Mapbox rate-limited (429); retrying', { waitMs }, 'warn');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (!response.ok) throw new Error(`Mapbox HTTP ${response.status}`);
      const body = await response.json();
      return (Array.isArray(body?.features) ? body.features : []).map(parseFeature).filter((f: MapboxFeature | null): f is MapboxFeature => !!f);
    }
  }

  private static baseParams(options: SearchOptions): Record<string, string> {
    return {
      language: 'en',
      limit: String(options.limit ?? 10),
      ...(options.proximity ? { proximity: `${options.proximity[0]},${options.proximity[1]}` } : {}),
      ...(options.country ? { country: options.country.toLowerCase() } : {}),
      ...(options.bbox ? { bbox: options.bbox.join(',') } : {}),
    };
  }

  /** Venues (restaurants, shops, parks…) via the Search Box API. */
  static searchPoi(query: string, options: SearchOptions = {}): Promise<MapboxFeature[]> {
    return this.request(SEARCH_BOX_URL, { q: query.slice(0, 256), types: 'poi', ...this.baseParams(options) });
  }

  /** Cities, neighbourhoods or street addresses via Geocoding v6. */
  static geocode(query: string, types: 'place' | 'neighborhood' | 'address', options: SearchOptions = {}): Promise<MapboxFeature[]> {
    return this.request(GEOCODING_V6_URL, { q: query.slice(0, 256), types, ...this.baseParams({ limit: 5, ...options }) });
  }

  /**
   * Neighbourhoods, districts and towns via Geocoding v6, searched by name
   * only; pass the city centre as `proximity`. Adding the city to the text
   * made Mapbox match the city words instead (measured on 2026-09-25:
   * "Greenwhich Vilage, New York" returned "New York Avenue, Trenton").
   */
  static geocodeArea(query: string, options: SearchOptions = {}): Promise<MapboxFeature[]> {
    return this.request(GEOCODING_V6_URL, { q: query.slice(0, 256), types: 'neighborhood,locality,place', ...this.baseParams({ limit: 5, ...options }) });
  }

  /**
   * Streets via Geocoding v6, by name only. The business search returns
   * businesses and stops named after a street instead ("Canal Street" → a
   * Staten Island bus stop, "Bleecker Street" → Bleecker Street Pizza).
   */
  static geocodeStreet(query: string, options: SearchOptions = {}): Promise<MapboxFeature[]> {
    return this.request(GEOCODING_V6_URL, { q: query.slice(0, 256), types: 'street', ...this.baseParams({ limit: 5, ...options }) });
  }
}
