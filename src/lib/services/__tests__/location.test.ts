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
