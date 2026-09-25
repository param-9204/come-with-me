import { NextResponse } from 'next/server';
import { UrlProcessingJobsService } from '@/lib/services/url-processing-jobs.service';

/** Mobile polling endpoint: GET /api/process-url/{jobId}. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ job_id: string }> },
) {
  try {
    const { job_id: jobId } = await params;
    if (!jobId) return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });

    const job = await UrlProcessingJobsService.getJob(jobId);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });

    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: job.status,
      socialPostId: job.social_post_id,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      error: job.status === 'failed' ? job.last_error : null,
      result: job.result,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Unable to read processing job' }, { status: 500 });
  }
}
