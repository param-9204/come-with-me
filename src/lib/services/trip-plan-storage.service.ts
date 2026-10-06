import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import type { TripPlan, TripPlanRequest } from './trip-planner.service';

export const TRIP_PLANNER_VERSION = 1;

export type CanonicalTripInput = {
  city: string;
  days: number;
  pace: string;
  include_categories: string[];
  exclude_categories: string[];
  must_visit_place_ids: string[];
  planner_version: number;
};

export type StoredTripPlan = {
  id: string;
  user_id: string;
  reuse_key: string;
  intent_key: string;
  input_data: CanonicalTripInput & { eligible_saved_place_ids: string[] };
  response_data: { reply: string; trip_plan: TripPlan };
  created_at: string;
  updated_at: string;
};

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedPlan(value: unknown): StoredTripPlan | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.user_id !== 'string' ||
    typeof value.reuse_key !== 'string' || typeof value.intent_key !== 'string' ||
    !isRecord(value.input_data) || !isRecord(value.response_data) ||
    typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') return null;
  const response = value.response_data;
  if (typeof response.reply !== 'string' || !isRecord(response.trip_plan)) return null;
  return value as unknown as StoredTripPlan;
}

export function canonicalTripInput(request: TripPlanRequest): CanonicalTripInput {
  return {
    city: request.city.trim().toLocaleLowerCase(),
    days: Math.max(1, Math.min(14, Math.floor(request.days))),
    pace: request.pace || 'balanced',
    include_categories: cleanList(request.includeCategories).map((value) => value.toLocaleLowerCase()),
    exclude_categories: cleanList(request.excludeCategories).map((value) => value.toLocaleLowerCase()),
    must_visit_place_ids: cleanList(request.mustVisitPlaceIds),
    planner_version: TRIP_PLANNER_VERSION,
  };
}

export function savedPlaceIdsForPlan(plan: TripPlan): string[] {
  const ids = [
    ...plan.days.flatMap((day) => day.stops.map((stop) => stop.id)),
    ...plan.optional_places.map((place) => place.id),
    ...plan.unroutable_places.map((place) => place.id),
  ];
  return cleanList(ids);
}

export function intentKey(input: CanonicalTripInput): string {
  return hash(input);
}

export function reuseKey(userId: string, canonicalInput: CanonicalTripInput, eligibleSavedPlaceIds: string[]): string {
  return hash({ user_id: userId, intent: canonicalInput, eligible_saved_place_ids: cleanList(eligibleSavedPlaceIds) });
}

export class TripPlanStorageService {
  static async findPrivate(userId: string, key: string): Promise<StoredTripPlan | null> {
    const { data, error } = await supabaseAdmin
      .from('trip_plans')
      .select('*')
      .eq('user_id', userId)
      .eq('reuse_key', key)
      .maybeSingle();
    if (error) throw new Error(`Unable to read saved trip plan: ${error.message}`);
    return storedPlan(data);
  }

  /** Every saved plan is available as a shared template for the same trip intent. */
  static async findMatchingPlan(intent: string): Promise<StoredTripPlan | null> {
    const { data, error } = await supabaseAdmin
      .from('trip_plans')
      .select('*')
      .eq('intent_key', intent)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`Unable to read matching trip plans: ${error.message}`);

    return storedPlan(data?.[0]);
  }

  static async save(params: {
    userId: string;
    canonicalInput: CanonicalTripInput;
    eligibleSavedPlaceIds: string[];
    reply: string;
    tripPlan: TripPlan;
  }): Promise<StoredTripPlan> {
    const key = reuseKey(params.userId, params.canonicalInput, params.eligibleSavedPlaceIds);
    const inputData = { ...params.canonicalInput, eligible_saved_place_ids: cleanList(params.eligibleSavedPlaceIds) };
    const payload = {
      user_id: params.userId,
      reuse_key: key,
      intent_key: intentKey(params.canonicalInput),
      input_data: inputData,
      response_data: { reply: params.reply, trip_plan: params.tripPlan },
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabaseAdmin
      .from('trip_plans')
      .upsert(payload, { onConflict: 'user_id,reuse_key' })
      .select('*')
      .single();
    if (error) throw new Error(`Unable to save trip plan: ${error.message}`);
    const saved = storedPlan(data);
    if (!saved) throw new Error('Saved trip plan could not be read back.');
    return saved;
  }

  static async listForUser(userId: string): Promise<StoredTripPlan[]> {
    const { data, error } = await supabaseAdmin
      .from('trip_plans')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw new Error(`Unable to list trip plans: ${error.message}`);
    return (data || []).map(storedPlan).filter((plan): plan is StoredTripPlan => plan !== null);
  }
}
