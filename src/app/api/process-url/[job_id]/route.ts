import { NextResponse } from 'next/server';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { ImageProcessingJobsService } from '@/lib/services/image-processing-jobs.service';
import { UrlProcessingJobsService } from '@/lib/services/url-processing-jobs.service';

/** Mobile polling endpoint: GET /api/process-url/{jobId}. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ job_id: string }> },
) {
  try {
    const { job_id: jobId } = await params;
    if (!jobId) return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });

    const job = await UrlProcessingJobsService.getJob(jobId);
    if (!job) {
      // Image job IDs belong to uploaded_images, not the URL job queue. Keep
      // existing URL polling unchanged and authorize only this image fallback.
      const user = await getAuthUser(request);
      const userId = user && await resolveProfileId({ clerkId: user.clerkId, userIdInput: user.id, email: user.email });
      const imageJob = userId && await ImageProcessingJobsService.getJobForUser(jobId, userId);
      // Do not disclose private image jobs to an unauthenticated caller or
      // another owner; unknown jobs retain this endpoint's existing 404.
      if (!imageJob) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });

      return NextResponse.json({
        // Completed image jobs expose the same result fields as post retrieval,
        // while retaining result for clients that read the polling envelope.
        ...(imageJob.result || {}),
        success: true,
        jobId: imageJob.id,
        status: imageJob.status,
        sourceType: imageJob.sourceType,
        uploadedImageId: imageJob.uploadedImageId,
        attemptCount: imageJob.attemptCount,
        maxAttempts: imageJob.maxAttempts,
        error: imageJob.error,
        suggested_title: typeof imageJob.result?.suggested_title === 'string' ? imageJob.result.suggested_title : null,
        result: imageJob.result,
        createdAt: imageJob.createdAt,
        updatedAt: imageJob.updatedAt,
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: job.status,
      socialPostId: job.social_post_id,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      error: job.status === 'failed' ? job.last_error : null,
      suggested_title: typeof job.result?.suggested_title === 'string' ? job.result.suggested_title : null,
      result: job.result,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Unable to read processing job' }, { status: 500 });
  }
}
