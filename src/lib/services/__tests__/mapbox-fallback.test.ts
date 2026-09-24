import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationService } from '../location.service';

vi.mock('@/lib/supabase', () => ({ supabaseAdmin: {} }));
import { verifiedEvidence } from '../db.service';

function mockFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const { status = 200, body } = handler(String(url));
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

const poi = (name: string, address: string, place: string, lng: number, lat: number, extraContext: Record<string, unknown> = {}) => ({
  properties: {
    name,
    full_address: address,
    feature_type: 'poi',
    mapbox_id: `mb-${name}-${lng}`,
    poi_category: ['food', 'restaurant'],
    coordinates: { latitude: lat, longitude: lng },
    context: { place: { name: place }, country: { country_code: 'us' }, ...extraContext },
  },
});
const newYorkCity = {
  properties: {
    name: 'New York', full_address: 'New York, New York, United States', feature_type: 'place',
    coordinates: { latitude: 40.7127, longitude: -74.006 }, context: { place: { name: 'New York' } },
  },
};
const withCity = (pois: unknown[]) => (url: string) =>
  url.includes('/geocode/v6/') ? { body: { features: [newYorkCity] } } : { body: { features: pois } };

beforeEach(() => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test';
  (LocationService as unknown as { mapboxCityCentres: Map<string, unknown> }).mapboxCityCentres.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
});

describe('Mapbox fallback', () => {
  it('queries by name only, biased to the city centre, and never stores a Mapbox id as a Google id', async () => {
    const calls = mockFetch(withCity([poi('Brasserie Cognac', '517 Lexington Ave, New York, New York 10017, United States', 'New York City', -73.9729, 40.7553)]));
    const result = await LocationService.geocodePlace('Brasserie Cognac', 'New York');
    expect(result).toMatchObject({ provider: 'mapbox', lat: 40.7553, lng: -73.9729, placeId: null, matchedName: 'Brasserie Cognac' });
    const poiCall = new URL(calls.find((url) => url.includes('searchbox'))!);
    expect(poiCall.searchParams.get('q')).toBe('Brasserie Cognac');
    expect(poiCall.searchParams.get('proximity')).toBe('-74.006,40.7127');
    expect(poiCall.searchParams.get('country')).toBe('us');
  });

  it('does not accept a same-name place in New Jersey for New York', async () => {
    mockFetch(withCity([
      poi('Mariscos el submarino', '103 Christopher Columbus Dr, Jersey City, New Jersey 07302, United States', 'Jersey City', -74.043, 40.719),
      poi('Mariscos El Submarino', '507 Myrtle Ave, Brooklyn, New York 11205, United States', 'New York City', -73.9646, 40.6938),
    ]));
    const result = await LocationService.geocodePlace('Mariscos El Submarino', 'New York');
    expect(result.formattedAddress).toBe('507 Myrtle Ave, Brooklyn, New York 11205, United States');
  });

  it('retries without a neighbourhood that came from the itinerary rather than the place', async () => {
    mockFetch(withCity([
      poi("L'industrie Pizzeria", '254 South 2nd Street, Brooklyn, New York 11211, United States', 'New York City', -73.9604, 40.7115, { neighborhood: { name: 'Williamsburg' } }),
    ]));
    const result = await LocationService.geocodePlace("L'industrie Pizzeria", 'New York', '', 'Dumbo');
    expect(result).toMatchObject({ provider: 'mapbox', neighborhood: 'Williamsburg' });
  });

  it('retries once when Mapbox returns an empty result', async () => {
    let poiCalls = 0;
    mockFetch((url) => {
      if (url.includes('/geocode/v6/')) return { body: { features: [newYorkCity] } };
      poiCalls++;
      return { body: { features: poiCalls === 1 ? [] : [poi('Hay Hay Roasted', '81 Mott St, New York, New York 10013, United States', 'New York City', -73.998, 40.7166)] } };
    });
    const result = await LocationService.geocodePlace('Hay Hay Roasted', 'New York');
    expect(poiCalls).toBe(2);
    expect(result.lat).toBe(40.7166);
  });

  it('treats a leading article as the same name ("GAZ" = "le gaz")', () => {
    expect(LocationService.nameSimilarity('Gaz', 'le gaz')).toBeGreaterThanOrEqual(0.85);
  });

  it('accepts a provider listing with only farm/winery descriptors added', () => {
    expect(LocationService.nameSimilarity('Casa Carmen Winery', 'Casa Carmen Farm and Winery')).toBeGreaterThanOrEqual(0.85);
  });
});

describe('verification notes name the provider', () => {
  it('says which service verified the location', () => {
    const place = { confidence: 0.7, explanation: 'Name found in the caption.' };
    expect(verifiedEvidence(place, { verified: true, provider: 'mapbox' }).explanation).toBe('Name found in the caption. Verified on Mapbox.');
    expect(verifiedEvidence(place, { verified: true, provider: 'google' }).explanation).toBe('Name found in the caption. Verified on Google Maps.');
    expect(verifiedEvidence(place, { verified: true, provider: 'stored' }).explanation).toBe('Name found in the caption. Matches a place already on the map.');
  });
});
