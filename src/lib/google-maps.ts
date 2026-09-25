import 'server-only';

type PlaceForLocation = {
  id: string;
  name?: string | null;
  address?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type PlaceLocation = {
  place_id: string;
  address: string | null;
  map_url: string | null;
  latitude: number | null;
  longitude: number | null;
};

function fallbackAddress(place: PlaceForLocation) {
  return [place.address, place.neighborhood, place.city].filter(Boolean).join(', ') || null;
}

function coordinate(value: number | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Resolves a display address server-side. The API key is never sent to the
 * dashboard; the browser receives only the resolved address and map link.
 */
export async function resolvePlaceLocation(place: PlaceForLocation): Promise<PlaceLocation> {
  let latitude = coordinate(place.latitude);
  let longitude = coordinate(place.longitude);
  const address = fallbackAddress(place);
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if ((latitude === null || longitude === null) && !apiKey) {
    return { place_id: place.id, address, map_url: null, latitude: null, longitude: null };
  }

  try {
    const locationQuery = latitude !== null && longitude !== null
      ? `latlng=${latitude},${longitude}`
      : `address=${encodeURIComponent([place.name, address].filter(Boolean).join(', '))}`;
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${locationQuery}&key=${encodeURIComponent(apiKey!)}`,
      { next: { revalidate: 86_400 } }
    );
    const payload = await response.json() as { results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }> };
    const result = response.ok ? payload.results?.[0] : null;
    const resolvedAddress = result?.formatted_address;
    latitude = latitude ?? coordinate(result?.geometry?.location?.lat);
    longitude = longitude ?? coordinate(result?.geometry?.location?.lng);
    const mapUrl = latitude !== null && longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`
      : null;

    return {
      place_id: place.id,
      address: resolvedAddress || address,
      map_url: mapUrl,
      latitude,
      longitude,
    };
  } catch {
    const mapUrl = latitude !== null && longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`
      : null;
    return { place_id: place.id, address, map_url: mapUrl, latitude, longitude };
  }
}
