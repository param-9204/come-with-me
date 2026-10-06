import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getAuthUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import {
  availableCities,
  buildTripPlan,
  categoryFiltersFromMessage,
  parseTripRequest,
  tripPlanReply,
  type TripPace,
  type TripPlanRequest,
  type TripPlannerPlace,
} from '@/lib/services/trip-planner.service';
import {
  canonicalTripInput,
  intentKey,
  reuseKey,
  savedPlaceIdsForPlan,
  TripPlanStorageService,
} from '@/lib/services/trip-plan-storage.service';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type DatabasePlace = Record<string, unknown>;
type TripStorageOptions = { save: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((item): item is string => item !== null) : [];
}

function messagesFrom(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null;
    const content = text(entry.content);
    return role && content ? [{ role, content }] : [];
  });
}

function tripRequestFrom(value: unknown): Partial<TripPlanRequest> {
  if (!isRecord(value)) return {};
  const days = number(value.days);
  const pace: TripPace | undefined = value.pace === 'relaxed' || value.pace === 'balanced' || value.pace === 'packed'
    ? value.pace
    : undefined;
  return {
    ...(text(value.city) ? { city: text(value.city)! } : {}),
    ...(days ? { days } : {}),
    ...(pace ? { pace } : {}),
    includeCategories: stringList(value.includeCategories),
    excludeCategories: stringList(value.excludeCategories),
    mustVisitPlaceIds: stringList(value.mustVisitPlaceIds),
  };
}

function tripStorageOptionsFrom(value: unknown): TripStorageOptions {
  if (!isRecord(value)) return { save: false };
  const save = value.save === true || value.savePlan === true;
  return { save };
}

async function savedPlacesForUser(userId: string): Promise<TripPlannerPlace[]> {
  const { data: saved, error: savedError } = await supabaseAdmin
    .from('saved_places')
    .select('place_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (savedError) throw new Error(`Unable to read saved places: ${savedError.message}`);

  const savedAtByPlace = new Map<string, string>();
  for (const entry of saved || []) {
    if (typeof entry.place_id === 'string' && !savedAtByPlace.has(entry.place_id)) {
      savedAtByPlace.set(entry.place_id, typeof entry.created_at === 'string' ? entry.created_at : '');
    }
  }
  const placeIds = [...savedAtByPlace.keys()];
  if (placeIds.length === 0) return [];

  const { data: places, error: placesError } = await supabaseAdmin
    .from('places')
    .select('*')
    .in('id', placeIds);
  if (placesError) throw new Error(`Unable to read saved place details: ${placesError.message}`);

  return (places || []).flatMap((place: DatabasePlace) => {
    const id = text(place.id);
    const name = text(place.name);
    if (!id || !name || !savedAtByPlace.has(id)) return [];
    return [{
      id,
      name,
      city: text(place.city),
      neighborhood: text(place.neighborhood),
      address: text(place.address),
      category: text(place.category),
      description: text(place.description),
      latitude: number(place.latitude),
      longitude: number(place.longitude),
      google_place_id: text(place.google_place_id),
      saved_at: savedAtByPlace.get(id) || null,
    }];
  });
}

function savedPlaceSummary(places: TripPlannerPlace[]): string {
  if (places.length === 0) return 'The user has no saved places yet.';
  return places.slice(0, 60).map((place) => [
    place.name,
    place.city || 'city unknown',
    place.neighborhood || 'area unknown',
    place.category || 'uncategorized',
  ].join(' | ')).join('\n');
}

function noAiReply(places: TripPlannerPlace[]): string {
  const cities = availableCities(places);
  if (places.length === 0) return 'Save places first, then ask me to plan a trip using them.';
  return `I can help with your ${places.length} saved place${places.length === 1 ? '' : 's'}. ` +
    `Try: “Plan 2 days in ${cities[0] || 'this city'} using my saved places.”`;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized. Authenticated session required.' }, { status: 401 });

    const body: unknown = await request.json();
    const bodyRecord = isRecord(body) ? body : {};
    const messages = messagesFrom(bodyRecord.messages);
    if (messages.length === 0) return NextResponse.json({ error: 'At least one chat message is required.' }, { status: 400 });

    const places = await savedPlacesForUser(user.id);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
    const tripInput = tripRequestFrom(bodyRecord.trip);
    const tripStorage = tripStorageOptionsFrom(bodyRecord.trip);
    const parsedTrip = parseTripRequest(lastUserMessage, availableCities(places), tripInput);

    if (parsedTrip.requested) {
      if (!parsedTrip.city) {
        return NextResponse.json({
          success: true,
          needs_clarification: true,
          reply: places.length === 0
            ? 'You have no saved places yet. Save places first, then tell me the city and number of days.'
            : `Which city should I plan? Your saved places are in: ${availableCities(places).join(', ')}.`,
          available_cities: availableCities(places),
        });
      }

      const inferredCategories = categoryFiltersFromMessage(lastUserMessage, places);
      const planRequest: TripPlanRequest = {
        city: parsedTrip.city,
        days: parsedTrip.days,
        pace: parsedTrip.pace,
        includeCategories: tripInput.includeCategories?.length ? tripInput.includeCategories : inferredCategories.includeCategories,
        excludeCategories: tripInput.excludeCategories?.length ? tripInput.excludeCategories : inferredCategories.excludeCategories,
        mustVisitPlaceIds: tripInput.mustVisitPlaceIds,
      };
      // Planning is deterministic and local, so we can calculate the current
      // candidate set before looking up a stored response without calling AI.
      const tripPlan = buildTripPlan(places, planRequest);
      const canonicalInput = canonicalTripInput(planRequest);
      const eligibleSavedPlaceIds = savedPlaceIdsForPlan(tripPlan);
      const existing = await TripPlanStorageService.findPrivate(
        user.id,
        reuseKey(user.id, canonicalInput, eligibleSavedPlaceIds),
      );
      if (existing) {
        return NextResponse.json({
          success: true,
          reused: true,
          source: 'private_saved_plan',
          trip_plan_id: existing.id,
          reply: existing.response_data.reply,
          trip_plan: existing.response_data.trip_plan,
          available_cities: existing.response_data.trip_plan.available_cities,
        });
      }

      const matchingPlan = await TripPlanStorageService.findMatchingPlan(intentKey(canonicalInput));
      if (matchingPlan) {
        return NextResponse.json({
          success: true,
          reused: true,
          source: 'shared_saved_plan',
          // This belongs to another user. Do not expose their private record id.
          trip_plan_id: null,
          reply: matchingPlan.response_data.reply,
          trip_plan: matchingPlan.response_data.trip_plan,
          available_cities: matchingPlan.response_data.trip_plan.available_cities,
        });
      }

      const reply = tripPlanReply(tripPlan);
      const savedPlan = tripStorage.save
        ? await TripPlanStorageService.save({
            userId: user.id,
            canonicalInput,
            eligibleSavedPlaceIds,
            reply,
            tripPlan,
          })
        : null;
      return NextResponse.json({
        success: true,
        reused: false,
        source: savedPlan ? 'new_saved_plan' : 'new_draft',
        trip_plan_id: savedPlan?.id || null,
        reply,
        trip_plan: tripPlan,
        available_cities: tripPlan.available_cities,
      });
    }

    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    if (!openAiKey) {
      return NextResponse.json({ success: true, reply: noAiReply(places), available_cities: availableCities(places) });
    }

    const client = new OpenAI({ apiKey: openAiKey });
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_SCOUT_CHAT_MODEL?.trim() || 'gpt-4o',
      max_tokens: 250,
      messages: [
        {
          role: 'system',
          content: `You are Ruby, a warm personal city insider. These are the user's actual saved places:\n${savedPlaceSummary(places)}\n\n` +
            'Never claim a place is saved unless it appears above. For trip planning, ask the user for a city and day count when missing. Keep answers concise and useful.',
        },
        ...messages,
      ],
    });
    const reply = response.choices[0]?.message?.content
      ? response.choices[0].message.content
      : 'Sorry, I could not prepare an answer.';
    return NextResponse.json({ success: true, reply, available_cities: availableCities(places) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to process Scout Chat request.';
    console.error('[Scout Chat] Request failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
