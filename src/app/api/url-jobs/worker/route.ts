import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { UrlProcessingJobsService } from '@/lib/services/url-processing-jobs.service';

export const maxDuration = 300;

function isWorkerRequest(request: Request): boolean {
  const secret = process.env.URL_JOB_WORKER_SECRET;
  if (!secret) return false;
  return request.headers.get('x-url-job-worker') === secret || request.headers.get('authorization') === `Bearer ${secret}`;
}

async function runWorker(request: Request) {
  if (!isWorkerRequest(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized worker request' }, { status: 401 });
  }
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit') || 2);
  const limit = Number.isFinite(requestedLimit) ? Math.min(3, Math.max(1, Math.floor(requestedLimit))) : 2;
  const result = await UrlProcessingJobsService.drain(new URL(request.url).origin, `worker-${uuidv4()}`, limit);
  return NextResponse.json({ success: true, ...result });
}

/** Call from a protected scheduler every minute, or after a mobile batch is submitted. */
export async function POST(request: Request) {
  try {
    return await runWorker(request);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Worker failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    return await runWorker(request);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Worker failed' }, { status: 500 });
  }
}
