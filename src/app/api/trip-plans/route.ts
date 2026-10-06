import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { TripPlanStorageService } from '@/lib/services/trip-plan-storage.service';

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized. Authenticated session required.' }, { status: 401 });

    const plans = await TripPlanStorageService.listForUser(user.id);
    return NextResponse.json({
      success: true,
      plans: plans.map((plan) => ({
        id: plan.id,
        input: plan.input_data,
        reply: plan.response_data.reply,
        trip_plan: plan.response_data.trip_plan,
        created_at: plan.created_at,
        updated_at: plan.updated_at,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to list trip plans.';
    console.error('[Trip Plans] List failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
