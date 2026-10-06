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

/**
 * Opens an ordered walking route. This does not calculate travel durations;
 * Google Maps calculates those live, using the destination coordinates only.
 */
export function googleMapsDirectionsUrl(places: Array<{
  latitude?: number | null;
  longitude?: number | null;
}>): string | null {
  const points = places
    .filter((place) => typeof place.latitude === 'number' && typeof place.longitude === 'number' &&
      Number.isFinite(place.latitude) && Number.isFinite(place.longitude))
    .map((place) => `${place.latitude},${place.longitude}`);

  if (points.length === 0) return null;
  if (points.length === 1) {
    return googleMapsUrl({
      latitude: Number(points[0].split(',')[0]),
      longitude: Number(points[0].split(',')[1]),
    });
  }

  const params = new URLSearchParams({
    api: '1',
    origin: points[0],
    destination: points[points.length - 1],
    travelmode: 'walking',
  });
  if (points.length > 2) params.set('waypoints', points.slice(1, -1).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}
