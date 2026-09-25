/**
 * Google Maps link for a verified place: opens the exact listing when the
 * Google place id is known, otherwise a pin at the verified coordinates.
 * Uses the documented Maps URLs format (https://www.google.com/maps/search/?api=1).
 */
export function googleMapsUrl(place: {
  latitude?: number | null;
  longitude?: number | null;
  google_place_id?: string | null;
}): string | null {
  if (typeof place.latitude !== 'number' || typeof place.longitude !== 'number') return null;
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return null;
  const params = new URLSearchParams({ api: '1', query: `${place.latitude},${place.longitude}` });
  if (place.google_place_id) params.set('query_place_id', place.google_place_id);
  return `https://www.google.com/maps/search/?${params}`;
}
