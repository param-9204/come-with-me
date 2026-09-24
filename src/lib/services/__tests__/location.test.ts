import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationService } from '../location.service';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> };

function mockFetch(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const { status = 200, body, headers = {} } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status, headers });
  }));
  return calls;
}

const place = (overrides: Record<string, unknown>) => ({
  id: 'place-1',
  displayName: { text: 'Buvette' },
  formattedAddress: '42 Grove St, New York, NY 10014, USA',
  location: { latitude: 40.7331, longitude: -74.0045 },
  types: ['french_restaurant', 'restaurant'],
  primaryType: 'french_restaurant',
  addressComponents: [
    { longText: 'West Village', types: ['neighborhood'] },
    { longText: 'New York', types: ['locality'] },
    { shortText: 'US', types: ['country'] },
  ],
  ...overrides,
});

const dailyQuotaError = {
  error: {
    status: 'RESOURCE_EXHAUSTED',
    message: "Quota exceeded for quota metric 'SearchTextRequest' and limit 'SearchTextRequest per day'",
    details: [{ metadata: { quota_unit: '1/d/{project}', quota_limit_value: '100', window_start_time: String(Math.floor(Date.now() / 1000)) } }],
  },
};

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  (LocationService as unknown as Record<string, number>).placesQuotaBlockedUntil = 0;
  (LocationService as unknown as Record<string, number>).geocodingDeniedUntil = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_MAPS_API_KEY;
});

describe('LocationService without the Geocoding API', () => {
  it('rejects founding-year prose as an address while preserving real addresses', () => {
    expect(LocationService.sanitizeSourceAddress('2017 by Street')).toBe('');
    expect(LocationService.sanitizeSourceAddress('Founded in 2017 by two brothers')).toBe('');
    expect(LocationService.sanitizeSourceAddress('49 Camino Wy')).toBe('49 Camino Wy');
    expect(LocationService.sanitizeSourceAddress('110 SE 6th St Suite 115')).toBe('110 SE 6th St Suite 115');
    expect(LocationService.sanitizeSourceAddress('10 we Street')).toBe('');
    expect(LocationService.sanitizeSourceAddress('17 courses Street')).toBe('');
    expect(LocationService.sanitizeSourceAddress('10 Eats Street')).toBe('');
  });

  it('retries a venue by name and city after rejecting an untrusted source address', async () => {
    const queries: string[] = [];
    mockFetch((_url, init) => {
      queries.push(JSON.parse(String(init?.body || '{}')).textQuery || '');
      return { body: { places: [place({ displayName: { text: 'Culture Espresso' }, formattedAddress: '72 W 38th St, New York, NY 10018, USA' })] } };
    });
    const result = await LocationService.geocodePlace('Culture Espresso', 'New York', '10 we Street');
    expect(queries[0]).toBe('Culture Espresso, New York');
    expect(result).toMatchObject({ matchedName: 'Culture Espresso', formattedAddress: '72 W 38th St, New York, NY 10018, USA' });
  });

  it('resolves a city centre from the Places result typed locality', async () => {
    const calls = mockFetch(() => ({
      body: {
        places: [
          place({ id: 'venue', displayName: { text: 'New York Pizza' }, types: ['restaurant'] }),
          place({ id: 'city', displayName: { text: 'New York' }, types: ['locality', 'political'], formattedAddress: 'New York, NY, USA', location: { latitude: 40.7128, longitude: -74.006 } }),
        ],
      },
    }));
    const result = await LocationService.geocodePlace('', 'New York');
    expect(result).toMatchObject({ lat: 40.7128, lng: -74.006, city: 'New York', placeId: null });
    expect(calls.every((url) => url.includes('places.googleapis.com'))).toBe(true);
  });

  it('resolves a street address from Places without storing the building id as the venue id', async () => {
    mockFetch((url, init) => {
      const query = JSON.parse(String(init?.body || '{}')).textQuery || '';
      if (query.startsWith('Zzq Popup')) return { body: { places: [] } };
      return {
        body: {
          places: [place({
            id: 'building', displayName: { text: '140 N 2nd St' }, types: ['premise', 'street_address'],
            formattedAddress: '140 N 2nd St, Philadelphia, PA 19106, USA',
            addressComponents: [{ longText: 'Philadelphia', types: ['locality'] }, { longText: 'Center City East', types: ['neighborhood'] }],
          })],
        },
      };
    });
    const result = await LocationService.geocodePlace('Zzq Popup Supper Club', 'Philadelphia', '140 N 2nd St');
    expect(result).toMatchObject({ formattedAddress: '140 N 2nd St, Philadelphia, PA 19106, USA', neighborhood: 'Center City East', placeId: null });
  });

  it('treats a disabled Geocoding API as unavailable instead of failing every lookup', async () => {
    const calls = mockFetch((url) => url.includes('/geocode/')
      ? { body: { status: 'REQUEST_DENIED', error_message: 'This API is not activated on your API project.' } }
      : { body: { places: [] } });
    await expect(LocationService.geocodePlace('', 'Philadelphia')).resolves.toMatchObject({ lat: null });
    const geocodeCalls = calls.filter((url) => url.includes('/geocode/')).length;
    await LocationService.geocodePlace('', 'Chicago');
    await LocationService.getNeighborhood(40.7, -74);
    expect(calls.filter((url) => url.includes('/geocode/')).length).toBe(geocodeCalls);
  });
});

describe('Places quota handling', () => {
  it('stops calling Places after a daily-quota error (no retries, no further requests)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = mockFetch(() => ({ status: 429, body: dailyQuotaError }));
    await expect(LocationService.geocodePlace('Buvette', 'New York')).resolves.toMatchObject({ lat: null });
    expect(calls).toHaveLength(1);
    await LocationService.geocodePlace('Morandi', 'New York');
    expect(calls).toHaveLength(1);
    expect(LocationService.placesQuotaExhausted()).toBe(true);
    const reported = error.mock.calls.find(([, message]) => String(message).includes('daily quota exhausted'));
    expect(reported).toBeDefined();
    expect(JSON.parse(String(reported![2]))).toMatchObject({ limitPerDay: '100' });
  });

  it('retries a per-minute rate limit and then succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    mockFetch(() => (++attempts === 1
      ? { status: 429, body: { error: { details: [{ metadata: { quota_unit: '1/min/{project}' } }] } }, headers: { 'retry-after': '0' } }
      : { body: { places: [place({})] } }));
    const result = await LocationService.geocodePlace('Buvette', 'New York', '', 'West Village');
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ matchedName: 'Buvette', placeId: 'place-1', neighborhood: 'West Village' });
  });
});

describe('Google first, Mapbox only as a fallback', () => {
  const mapboxCity = {
    properties: {
      name: 'New York', full_address: 'New York, New York, United States', feature_type: 'place',
      coordinates: { latitude: 40.7127, longitude: -74.006 }, context: { place: { name: 'New York' } },
    },
  };
  const mapboxPoi = (name: string, address: string, neighborhood: string) => ({
    properties: {
      name, full_address: address, feature_type: 'poi', mapbox_id: `mb-${name}`, poi_category: ['food', 'restaurant'],
      coordinates: { latitude: 40.7599, longitude: -73.9848 },
      context: { place: { name: 'New York City' }, neighborhood: { name: neighborhood }, country: { country_code: 'us' } },
    },
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test';
    (LocationService as unknown as { mapboxCityCentres: Map<string, unknown> }).mapboxCityCentres.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    vi.restoreAllMocks();
  });

  it('never calls Mapbox when Google verifies the place', async () => {
    const calls = mockFetch(() => ({ body: { places: [place({})] } }));
    const result = await LocationService.geocodePlace('Buvette', 'New York');
    expect(result).toMatchObject({ provider: 'google', matchedName: 'Buvette' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('places.googleapis.com');
  });

  it('re-checks the Google results without the neighbourhood before spending a request or calling Mapbox', async () => {
    // The post's context said Dumbo; Google lists Buvette in the West Village.
    const calls = mockFetch(() => ({ body: { places: [place({})] } }));
    const result = await LocationService.geocodePlace('Buvette', 'New York', '', 'Dumbo');
    expect(result).toMatchObject({ provider: 'google', neighborhood: 'West Village' });
    expect(calls).toHaveLength(1);
  });

  it('calls Mapbox only after every Google attempt misses, and sends each Mapbox search once (real case)', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('places.googleapis.com')) return { body: { places: [] } };
      if (url.includes('/geocode/v6/')) return { body: { features: [mapboxCity] } };
      return { body: { features: [mapboxPoi("Lillie's Victorian", '249 W 49th St, New York, New York 10019, United States', 'Theater District')] } };
    });
    const result = await LocationService.geocodePlace("Lillie's Victorian", 'New York', '', 'Midtown Manhattan');

    expect(result).toMatchObject({ provider: 'mapbox', formattedAddress: '249 W 49th St, New York, New York 10019, United States' });
    const google = calls.map((url, index) => (url.includes('places.googleapis.com') ? index : -1)).filter((index) => index >= 0);
    const mapbox = calls.map((url, index) => (url.includes('api.mapbox.com') ? index : -1)).filter((index) => index >= 0);
    expect(google).toHaveLength(2); // with and without the neighbourhood
    expect(Math.min(...mapbox)).toBeGreaterThan(Math.max(...google));
    const poiQueries = calls.filter((url) => url.includes('searchbox')).map((url) => new URL(url).searchParams.get('q'));
    expect(poiQueries).toEqual(["Lillie's Victorian", "Lillie's Victorian Midtown Manhattan"]);
  });

  it('goes straight to Mapbox while the Google daily quota is used up', async () => {
    (LocationService as unknown as Record<string, number>).placesQuotaBlockedUntil = Date.now() + 60_000;
    const calls = mockFetch((url) => (url.includes('/geocode/v6/')
      ? { body: { features: [mapboxCity] } }
      : { body: { features: [mapboxPoi('Buvette', '42 Grove St, New York, New York 10014, United States', 'West Village')] } }));
    const result = await LocationService.geocodePlace('Buvette', 'New York');
    expect(result).toMatchObject({ provider: 'mapbox' });
    expect(calls.some((url) => url.includes('places.googleapis.com'))).toBe(false);
  });
});
