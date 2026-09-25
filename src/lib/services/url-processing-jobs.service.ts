import { supabaseAdmin } from '@/lib/supabase';
import { urlJobWorkerSecret } from '@/lib/url-job-worker';

export type UrlProcessingJobStatus = 'queued' | 'processing' | 'waiting' | 'completed' | 'failed';

export type UrlProcessingJob = {
  id: string;
  user_id: string;
  source_url: string;
  canonical_source_key: string;
  platform: 'instagram' | 'tiktok';
  social_post_id: string | null;
  status: UrlProcessingJobStatus;
  attempt_count: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type CreateJobInput = Pick<UrlProcessingJob, 'source_url' | 'canonical_source_key' | 'platform' | 'social_post_id'> & {
  status?: UrlProcessingJobStatus;
  result?: Record<string, unknown> | null;
};

const JOB_COLUMNS = 'id, user_id, source_url, canonical_source_key, platform, social_post_id, status, attempt_count, max_attempts, run_after, locked_at, locked_by, last_error, result, created_at, updated_at';

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value || 'Processing failed');
}

function retryAt(attempt: number): string {
  const minutes = Math.min(15, Math.max(1, 2 ** Math.max(0, attempt - 1)));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export class UrlProcessingJobsService {
  static async createJobs(userId: string, inputs: CreateJobInput[]): Promise<UrlProcessingJob[]> {
    return Promise.all(inputs.map(async (input) => {
      const { status = 'queued', result = null, ...job } = input;
      const { data: created, error } = await supabaseAdmin
        .from('social_post_accesses')
        .insert({ ...job, user_id: userId, event: 'job', status, result })
        .select(JOB_COLUMNS)
        .single();
      if (!error && created) return created as UrlProcessingJob;
      throw new Error(`Unable to create processing job: ${error?.message || 'missing job'}`);
    }));
  }

  static async getJobForUser(id: string, userId: string): Promise<UrlProcessingJob | null> {
    const { data, error } = await supabaseAdmin
      .from('social_post_accesses')
      .select(JOB_COLUMNS)
      .eq('id', id)
      .eq('user_id', userId)
      .eq('event', 'job')
      .maybeSingle();
    if (error) throw new Error(`Unable to read processing job: ${error.message}`);
    return data as UrlProcessingJob | null;
  }

  /** Mobile job IDs are random server-generated UUIDs and act as the polling capability. */
  static async getJob(id: string): Promise<UrlProcessingJob | null> {
    const { data, error } = await supabaseAdmin
      .from('social_post_accesses')
      .select(JOB_COLUMNS)
      .eq('id', id)
      .eq('event', 'job')
      .maybeSingle();
    if (error) throw new Error(`Unable to read processing job: ${error.message}`);
    return data as UrlProcessingJob | null;
  }

  static async claim(workerId: string, limit: number): Promise<UrlProcessingJob[]> {
    const { data, error } = await supabaseAdmin.rpc('claim_url_processing_jobs', {
      p_worker_id: workerId,
      p_limit: Math.min(3, Math.max(1, Math.floor(limit))),
    });
    if (error) throw new Error(`Unable to claim processing jobs: ${error.message}`);
    return (data || []) as UrlProcessingJob[];
  }

  static async settleWaitingJobs(): Promise<void> {
    const { data: waiting, error } = await supabaseAdmin
      .from('social_post_accesses')
      .select('id, social_post_id')
      .eq('event', 'job')
      .eq('status', 'waiting')
      .not('social_post_id', 'is', null)
      .limit(100);
    if (error || !waiting?.length) return;

    const postIds = waiting.map((job) => job.social_post_id).filter(Boolean) as string[];
    const { data: posts } = await supabaseAdmin
      .from('social_posts')
      .select('id, status')
      .in('id', postIds);
    const statusByPost = new Map((posts || []).map((post) => [post.id, post.status]));

    await Promise.all(waiting.map(async (job) => {
      const status = statusByPost.get(job.social_post_id!);
      if (status === 'completed') {
        await supabaseAdmin.from('social_post_accesses').update({
          status: 'completed',
          result: { socialPostId: job.social_post_id, socialPostStatus: status },
          locked_at: null,
          locked_by: null,
        }).eq('id', job.id).eq('event', 'job').eq('status', 'waiting');
      } else if (status === 'failed') {
        await supabaseAdmin.from('social_post_accesses').update({
          status: 'queued',
          run_after: new Date().toISOString(),
          last_error: 'The shared social post failed; retrying through the queue.',
        }).eq('id', job.id).eq('event', 'job').eq('status', 'waiting');
      }
    }));
  }

  static async processClaimedJob(job: UrlProcessingJob, origin: string): Promise<void> {
    const workerSecret = urlJobWorkerSecret();
    if (!workerSecret) throw new Error('URL_JOB_WORKER_SECRET is required to process queued URLs');

    try {
      const response = await fetch(`${origin}/api/process-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-url-job-worker': workerSecret,
        },
        body: JSON.stringify({ url: job.source_url, userId: job.user_id }),
      });
      const payload = await response.json().catch(() => ({}));
      const socialPostId = typeof payload?.socialPostId === 'string' ? payload.socialPostId : null;

      if (response.ok && payload?.success && payload?.processing) {
        await this.finishWaiting(job, socialPostId, payload?.status || 'pending');
        return;
      }
      if (response.ok && payload?.success) {
        await this.finishCompleted(job, socialPostId, payload?.status || 'completed', Array.isArray(payload?.places) ? payload.places.length : 0);
        return;
      }
      throw new Error(payload?.error || `Processor returned HTTP ${response.status}`);
    } catch (error) {
      const message = errorMessage(error);
      const terminal = job.attempt_count >= job.max_attempts;
      const { error: updateError } = await supabaseAdmin
        .from('social_post_accesses')
        .update({
          status: terminal ? 'failed' : 'queued',
          run_after: terminal ? new Date().toISOString() : retryAt(job.attempt_count),
          locked_at: null,
          locked_by: null,
          last_error: message.slice(0, 2_000),
        })
        .eq('id', job.id)
        .eq('event', 'job')
        .eq('status', 'processing')
        .eq('locked_by', job.locked_by);
      if (updateError) console.error('[URL jobs] failed to record job error:', updateError.message);
    }
  }

  static async drain(origin: string, workerId: string, limit = 2): Promise<{ claimed: number }> {
    await this.settleWaitingJobs();
    const jobs = await this.claim(workerId, limit);
    await Promise.all(jobs.map((job) => this.processClaimedJob(job, origin)));
    // A duplicate URL may have entered `waiting` while the first job was still
    // scraping. Reconcile once more so it completes in the same drain when the
    // canonical post finished during this batch.
    await this.settleWaitingJobs();
    return { claimed: jobs.length };
  }

  private static async finishWaiting(job: UrlProcessingJob, socialPostId: string | null, socialPostStatus: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('social_post_accesses')
      .update({
        status: 'waiting',
        social_post_id: socialPostId,
        locked_at: null,
        locked_by: null,
        result: { socialPostId, socialPostStatus },
      })
      .eq('id', job.id)
      .eq('event', 'job')
      .eq('status', 'processing')
      .eq('locked_by', job.locked_by);
    if (error) throw new Error(`Unable to mark processing job as waiting: ${error.message}`);
  }

  private static async finishCompleted(job: UrlProcessingJob, socialPostId: string | null, socialPostStatus: string, placeCount: number): Promise<void> {
    const { error } = await supabaseAdmin
      .from('social_post_accesses')
      .update({
        status: 'completed',
        social_post_id: socialPostId,
        locked_at: null,
        locked_by: null,
        last_error: null,
        result: { socialPostId, socialPostStatus, placeCount },
      })
      .eq('id', job.id)
      .eq('event', 'job')
      .eq('status', 'processing')
      .eq('locked_by', job.locked_by);
    if (error) throw new Error(`Unable to complete processing job: ${error.message}`);
  }
}
