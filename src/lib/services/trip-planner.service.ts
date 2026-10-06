import { googleMapsDirectionsUrl, googleMapsUrl } from '../maps-url';

export type TripPace = 'relaxed' | 'balanced' | 'packed';

export type TripPlannerPlace = {
  id: string;
  name: string;
  city: string | null;
  neighborhood: string | null;
  address: string | null;
  category: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  google_place_id?: string | null;
  saved_at?: string | null;
};

export type TripPlanRequest = {
  city: string;
  days: number;
  pace?: TripPace;
  includeCategories?: string[];
  excludeCategories?: string[];
  mustVisitPlaceIds?: string[];
};

export type TripPlanStop = TripPlannerPlace & {
  sequence: number;
  map_url: string | null;
  must_visit: boolean;
};

export type TripPlanDay = {
  day: number;
  area: string | null;
  route_url: string | null;
  stops: TripPlanStop[];
  note: string;
};

export type UnroutableTripPlace = TripPlannerPlace & { reason: string };

export type TripPlan = {
  city: string;
  requested_days: number;
  pace: TripPace;
  source: 'saved_places';
  days: TripPlanDay[];
  scheduled_count: number;
  optional_places: TripPlannerPlace[];
  unroutable_places: UnroutableTripPlace[];
  excluded_places: TripPlannerPlace[];
  available_cities: string[];
};

export type ParsedTripRequest = {
  requested: boolean;
  city: string | null;
  days: number;
  pace: TripPace;
};

type Coordinate = { latitude: number; longitude: number };
type PlaceCluster = { places: TripPlannerPlace[]; centroid: Coordinate };

const DAY_CAPACITY: Record<TripPace, number> = {
  relaxed: 3,
  balanced: 4,
  packed: 6,
};

const DAY_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};

const CATEGORY_HINTS: Record<string, string[]> = {
  restaurants: ['restaurant', 'restaurants', 'food', 'dining', 'lunch', 'dinner', 'breakfast', 'brunch'],
  coffee: ['coffee', 'cafe', 'cafes', 'tea'],
  bars: ['bar', 'bars', 'cocktail', 'cocktails', 'wine'],
  nightlife: ['nightlife', 'club', 'clubs', 'late night'],
  culture: ['culture', 'museum', 'museums', 'gallery', 'galleries', 'art'],
  shopping: ['shopping', 'shop', 'shops', 'market', 'markets', 'boutique', 'boutiques'],
  nature: ['nature', 'park', 'parks', 'beach', 'beaches', 'hike'],
  adventure: ['adventure', 'activity', 'activities', 'tour'],
  travel: ['travel', 'hotel', 'hotels', 'stay', 'stays'],
  city: ['city', 'landmark', 'landmarks', 'neighborhood', 'neighbourhood'],
};

const NEARBY_CLUSTER_KM = 2.5;

function normalise(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function finiteCoordinate(place: TripPlannerPlace): Coordinate | null {
  return typeof place.latitude === 'number' && typeof place.longitude === 'number' &&
    Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
    ? { latitude: place.latitude, longitude: place.longitude }
    : null;
}

function kilometersBetween(a: Coordinate, b: Coordinate): number {
  const radians = (value: number) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const deltaLatitude = radians(b.latitude - a.latitude);
  const deltaLongitude = radians(b.longitude - a.longitude);
  const h = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function centroid(places: TripPlannerPlace[]): Coordinate {
  const coordinates = places.map(finiteCoordinate).filter((value): value is Coordinate => value !== null);
  return {
    latitude: coordinates.reduce((sum, point) => sum + point.latitude, 0) / coordinates.length,
    longitude: coordinates.reduce((sum, point) => sum + point.longitude, 0) / coordinates.length,
  };
}

function compareSavedAt(a: TripPlannerPlace, b: TripPlannerPlace): number {
  return String(a.saved_at || '').localeCompare(String(b.saved_at || '')) || a.name.localeCompare(b.name);
}

function routeOrder(places: TripPlannerPlace[], mustVisit: Set<string>): TripPlannerPlace[] {
  if (places.length < 2) return places;
  const remaining = [...places].sort((a, b) => {
    const mustVisitDifference = Number(mustVisit.has(b.id)) - Number(mustVisit.has(a.id));
    return mustVisitDifference || compareSavedAt(a, b);
  });
  const ordered = [remaining.shift()!];

  while (remaining.length > 0) {
    const lastCoordinate = finiteCoordinate(ordered[ordered.length - 1])!;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const distance = kilometersBetween(lastCoordinate, finiteCoordinate(remaining[index])!);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    ordered.push(remaining.splice(nearestIndex, 1)[0]);
  }
  return ordered;
}

function clusterPlaces(places: TripPlannerPlace[]): PlaceCluster[] {
  const unseen = new Set(places.map((place) => place.id));
  const byId = new Map(places.map((place) => [place.id, place]));
  const clusters: PlaceCluster[] = [];

  while (unseen.size > 0) {
    const firstId = unseen.values().next().value as string;
    const queue = [firstId];
    const members: TripPlannerPlace[] = [];
    unseen.delete(firstId);

    while (queue.length > 0) {
      const current = byId.get(queue.shift()!);
      if (!current) continue;
      members.push(current);
      const currentCoordinate = finiteCoordinate(current)!;
      for (const candidateId of [...unseen]) {
        const candidate = byId.get(candidateId)!;
        if (kilometersBetween(currentCoordinate, finiteCoordinate(candidate)!) <= NEARBY_CLUSTER_KM) {
          unseen.delete(candidateId);
          queue.push(candidateId);
        }
      }
    }
    clusters.push({ places: members, centroid: centroid(members) });
  }
  return clusters;
}

function orderClusters(clusters: PlaceCluster[], mustVisit: Set<string>): PlaceCluster[] {
  if (clusters.length < 2) return clusters;
  const remaining = [...clusters];
  remaining.sort((a, b) => {
    const aMustVisits = a.places.filter((place) => mustVisit.has(place.id)).length;
    const bMustVisits = b.places.filter((place) => mustVisit.has(place.id)).length;
    return bMustVisits - aMustVisits || compareSavedAt(a.places[0], b.places[0]);
  });
  const ordered = [remaining.shift()!];

  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1].centroid;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const distance = kilometersBetween(previous, remaining[index].centroid);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    ordered.push(remaining.splice(nearestIndex, 1)[0]);
  }
  return ordered;
}

function areaName(places: TripPlannerPlace[], city: string): string | null {
  const neighborhoods = [...new Set(places.map((place) => place.neighborhood?.trim()).filter(Boolean))] as string[];
  if (neighborhoods.length === 1) return neighborhoods[0];
  if (neighborhoods.length === 2) return neighborhoods.join(' and ');
  return city || null;
}

function matchesCategories(place: TripPlannerPlace, includeCategories: Set<string>, excludeCategories: Set<string>): boolean {
  const category = normalise(place.category);
  return (!includeCategories.size || includeCategories.has(category)) && !excludeCategories.has(category);
}

export function availableCities(places: TripPlannerPlace[]): string[] {
  return [...new Set(places.map((place) => place.city?.trim()).filter(Boolean) as string[])]
    .sort((a, b) => a.localeCompare(b));
}

export function parseTripRequest(message: string, cities: string[], input?: Partial<TripPlanRequest>): ParsedTripRequest {
  const text = message.trim();
  const requested = Boolean(input?.city || /\b(?:plan|itinerary|trip|route|weekend|\d+\s*days?)\b/i.test(text));
  const matchingCity = cities
    .sort((a, b) => b.length - a.length)
    .find((city) => new RegExp(`(^|[^\\p{L}])${normalise(city).replace(/ /g, '\\s+')}(?=$|[^\\p{L}])`, 'iu').test(normalise(text)));
  const genericCity = text.match(/\b(?:in|for|to)\s+([\p{L}][\p{L} .'-]{1,50}?)(?=\s+(?:for|with|using|from|on|starting)\b|[,?.!]|$)/iu)?.[1]?.trim() || null;
  const numericDays = text.match(/\b(\d{1,2})\s*days?\b/i)?.[1];
  const wordDays = Object.entries(DAY_WORDS).find(([word]) => new RegExp(`\\b${word}\\s+days?\\b`, 'i').test(text))?.[1];
  const days = Math.min(14, Math.max(1, Number(input?.days || numericDays || (wordDays ? DAY_WORDS[wordDays] : /\bweekend\b/i.test(text) ? 2 : 1))));
  const pace: TripPace = input?.pace || (/\b(?:relaxed|slow)\b/i.test(text) ? 'relaxed' : /\b(?:packed|busy|maximise|maximize)\b/i.test(text) ? 'packed' : 'balanced');
  return { requested, city: input?.city?.trim() || matchingCity || genericCity, days, pace };
}

/** Converts clear natural-language category constraints into saved-place filters. */
export function categoryFiltersFromMessage(message: string, places: TripPlannerPlace[]): Pick<TripPlanRequest, 'includeCategories' | 'excludeCategories'> {
  const normalizedMessage = normalise(message);
  const categories = [...new Set(places.map((place) => place.category?.trim()).filter(Boolean) as string[])];
  const detected = categories.filter((category) => {
    const normalizedCategory = normalise(category);
    const hints = CATEGORY_HINTS[normalizedCategory] || [normalizedCategory];
    return hints.some((hint) => new RegExp(`(?:^| )${hint.replace(/ /g, '\\s+')}(?=$| )`, 'i').test(normalizedMessage));
  });
  const excludes = detected.filter((category) => {
    const normalizedCategory = normalise(category);
    const hints = CATEGORY_HINTS[normalizedCategory] || [normalizedCategory];
    return hints.some((hint) => new RegExp(`\\b(?:no|without|avoid|excluding)\\s+(?:${hint.replace(/ /g, '\\s+')})\\b`, 'i').test(normalizedMessage));
  });
  const includes = /\b(?:only|just|focus(?:ed)?\s+on)\b/i.test(message)
    ? detected.filter((category) => !excludes.includes(category))
    : [];
  return { includeCategories: includes, excludeCategories: excludes };
}

export function buildTripPlan(allPlaces: TripPlannerPlace[], request: TripPlanRequest): TripPlan {
  const city = request.city.trim();
  const requestedDays = Math.min(14, Math.max(1, Math.floor(request.days)));
  const pace = request.pace || 'balanced';
  const includeCategories = new Set((request.includeCategories || []).map(normalise).filter(Boolean));
  const excludeCategories = new Set((request.excludeCategories || []).map(normalise).filter(Boolean));
  const mustVisit = new Set(request.mustVisitPlaceIds || []);
  const cityPlaces = allPlaces.filter((place) => normalise(place.city) === normalise(city));
  const excludedPlaces = cityPlaces.filter((place) => !matchesCategories(place, includeCategories, excludeCategories));
  const selected = cityPlaces.filter((place) => matchesCategories(place, includeCategories, excludeCategories));
  const unroutablePlaces: UnroutableTripPlace[] = selected
    .filter((place) => !finiteCoordinate(place))
    .map((place) => ({ ...place, reason: 'Missing verified latitude and longitude.' }));
  const routeable = selected.filter((place) => finiteCoordinate(place));
  const clusters = orderClusters(clusterPlaces(routeable), mustVisit)
    .map((cluster) => routeOrder(cluster.places, mustVisit));
  const pendingClusters = clusters.map((places) => [...places]);
  const days: TripPlanDay[] = [];

  for (let day = 1; day <= requestedDays; day += 1) {
    const capacity = DAY_CAPACITY[pace];
    const stops: TripPlannerPlace[] = [];
    while (stops.length < capacity && pendingClusters.length > 0) {
      const cluster = pendingClusters[0];
      const take = Math.min(capacity - stops.length, cluster.length);
      stops.push(...cluster.splice(0, take));
      if (cluster.length === 0) pendingClusters.shift();
      // Keep the day within an area when it already has stops. A second cluster
      // is only added when the first one was small enough to be a light day.
      if (stops.length > 0 && cluster.length === 0 && stops.length >= Math.ceil(capacity / 2)) break;
    }
    const orderedStops = routeOrder(stops, mustVisit);
    const dayArea = areaName(orderedStops, city);
    days.push({
      day,
      area: dayArea,
      route_url: googleMapsDirectionsUrl(orderedStops),
      stops: orderedStops.map((place, index) => ({
        ...place,
        sequence: index + 1,
        must_visit: mustVisit.has(place.id),
        map_url: googleMapsUrl(place),
      })),
      note: orderedStops.length > 0
        ? `Saved places grouped around ${dayArea || city}; route order minimizes backtracking.`
        : 'No additional routed saved places for this day. Keep it flexible or add more saved places.',
    });
  }

  return {
    city,
    requested_days: requestedDays,
    pace,
    source: 'saved_places',
    days,
    scheduled_count: days.reduce((count, day) => count + day.stops.length, 0),
    optional_places: pendingClusters.flat(),
    unroutable_places: unroutablePlaces,
    excluded_places: excludedPlaces,
    available_cities: availableCities(allPlaces),
  };
}

export function tripPlanReply(plan: TripPlan): string {
  if (plan.scheduled_count === 0) {
    if (plan.unroutable_places.length > 0) {
      return `I found ${plan.unroutable_places.length} saved place${plan.unroutable_places.length === 1 ? '' : 's'} in ${plan.city}, but none has verified coordinates for a reliable route.`;
    }
    return `I could not find matching saved places in ${plan.city}. I will only plan from your saved places unless you ask for new recommendations.`;
  }

  const days = plan.days
    .filter((day) => day.stops.length > 0)
    .map((day) => `Day ${day.day}${day.area ? ` — ${day.area}` : ''}: ${day.stops.map((stop) => stop.name).join(' → ')}`)
    .join('\n');
  const optional = plan.optional_places.length > 0
    ? `\n${plan.optional_places.length} saved place${plan.optional_places.length === 1 ? '' : 's'} kept optional so the itinerary is not overpacked.`
    : '';
  const unroutable = plan.unroutable_places.length > 0
    ? `\n${plan.unroutable_places.length} saved place${plan.unroutable_places.length === 1 ? '' : 's'} need location confirmation before routing.`
    : '';
  return `I planned ${plan.scheduled_count} of your saved places across ${plan.requested_days} day${plan.requested_days === 1 ? '' : 's'} in ${plan.city}.\n${days}${optional}${unroutable}`;
}
