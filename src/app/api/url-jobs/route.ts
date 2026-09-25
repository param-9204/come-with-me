import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { resolveCanonicalSocialSource } from '@/lib/social-source';
import { UrlProcessingJobsService } from '@/lib/services/url-processing-jobs.service';

export const maxDuration = 300;

const MAX_BATCH_SIZE = 20;

type RequestedJob = { url?: unknown; clientRequestId?: unknown };

function originFor(request: Request): string {
  let origin = new URL(request.url).origin;
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) origin = origin.replace('https://', 'http://');
  return origin;
}

async function authenticatedProfileId(request: Request): Promise<string | null> {
  const user = await getAuthUser(request);
  if (!user) return null;
  return resolveProfileId({ clerkId: user.clerkId, userIdInput: user.id, email: user.email });
}

/**
 * POST /api/url-jobs
 * Body: { jobs: [{ url, clientRequestId }], userId?: ignored }
 * Returns immediately. The supplied userId is never trusted; identity comes
 * from the verified mobile Bearer token or web session.
 */
export async function POST(request: Request) {
  try {
    const userId = await authenticatedProfileId(request);
    if (!userId) return NextResponse.json({ success: false, error: 'Authentication is required' }, { status: 401 });

    const body = await request.json().catch(() => null);
    const requested = body?.jobs;
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_BATCH_SIZE) {
      return NextResponse.json({ success: false, error: `jobs must contain 1 to ${MAX_BATCH_SIZE} URLs` }, { status: 400 });
    }

    const requestIds = new Set<string>();
    const prepared = requested.map((job: RequestedJob, index: number) => {
      if (!job || typeof job.url !== 'string' || typeof job.clientRequestId !== 'string' || !job.clientRequestId.trim()) {
        throw new Error(`jobs[${index}] requires url and clientRequestId`);
      }
      const clientRequestId = job.clientRequestId.trim();
      if (clientRequestId.length > 128 || requestIds.has(clientRequestId)) {
        throw new Error(`jobs[${index}] has a duplicate or invalid clientRequestId`);
      }
      requestIds.add(clientRequestId);
      return { url: job.url, clientRequestId };
    });
    const validated = await Promise.all(prepared.map(async (job) => {
      const source = await resolveCanonicalSocialSource(job.url);
      return {
        source_url: source.cleanUrl,
        canonical_source_key: source.key,
        platform: source.platform,
        client_request_id: job.clientRequestId,
      };
    }));

    const jobs = await UrlProcessingJobsService.createJobs(userId, validated);
    const scheduled = Boolean(process.env.URL_JOB_WORKER_SECRET);
    if (scheduled) {
      const origin = originFor(request);
      const workerId = `submit-${uuidv4()}`;
      after(async () => {
        try {
          await UrlProcessingJobsService.drain(origin, workerId, 2);
        } catch (error) {
          console.error('[URL jobs] immediate drain failed:', error);
        }
      });
    }

    return NextResponse.json({
      success: true,
      workerScheduled: scheduled,
      warning: scheduled ? null : 'Jobs are queued, but URL_JOB_WORKER_SECRET must be configured before a worker can process them.',
      jobs: jobs.map((job) => ({
        id: job.id,
        sourceUrl: job.source_url,
        status: job.status,
        clientRequestId: job.client_request_id,
      })),
    }, { status: 202 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Unable to create processing jobs' }, { status: 400 });
  }
}

/** GET /api/url-jobs?id=<job UUID> - mobile can poll only its own job. */
export async function GET(request: Request) {
  try {
    const userId = await authenticatedProfileId(request);
    if (!userId) return NextResponse.json({ success: false, error: 'Authentication is required' }, { status: 401 });
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });

    const job = await UrlProcessingJobsService.getJobForUser(id, userId);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        sourceUrl: job.source_url,
        status: job.status,
        socialPostId: job.social_post_id,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        retryAt: job.status === 'queued' ? job.run_after : null,
        error: job.status === 'failed' ? job.last_error : null,
        result: job.result,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Unable to read processing job' }, { status: 500 });
  }
}
