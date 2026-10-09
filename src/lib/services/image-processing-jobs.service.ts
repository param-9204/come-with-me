import { supabaseAdmin } from '@/lib/supabase';

// Image analysis runs within process-url's 300-second invocation. A terminated
// invocation must not leave mobile polling a pending upload indefinitely.
const IMAGE_JOB_TIMEOUT_MS = 6 * 60_000;
const IMAGE_JOB_TIMEOUT_MESSAGE = 'Image processing timed out. Please upload the images again.';

export class ImageProcessingJobsService {
  /** Upload IDs are image job IDs; only the verified upload owner can poll. */
  static async getJobForUser(id: string, userId: string) {
    const { data: job, error: jobError } = await supabaseAdmin
      .from('social_post_accesses')
      .select('id, uploaded_image_id, source_url, status, last_error, result, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('event', 'job')
      .eq('platform', 'upload')
      .maybeSingle();
    const missingMigration = jobError && (jobError.code === '42703' || jobError.code === 'PGRST204'
      || /column .* does not exist|schema cache/i.test(jobError.message || ''));
    if (jobError && !missingMigration) throw new Error(`Unable to read image processing job: ${jobError.message}`);
    if (job) {
      const timedOut = process.env.NODE_ENV === 'production' && job.status === 'processing'
        && Date.now() - Date.parse(job.created_at) > IMAGE_JOB_TIMEOUT_MS;
      const status = timedOut ? 'failed' : job.status;
      return {
        id: job.id,
        sourceUrl: job.source_url || null,
        status,
        socialPostId: null,
        uploadedImageId: job.uploaded_image_id,
        attemptCount: 1,
        maxAttempts: 1,
        retryAt: null,
        error: timedOut ? IMAGE_JOB_TIMEOUT_MESSAGE : status === 'failed' ? job.last_error : null,
        result: status === 'completed' ? job.result : null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      };
    }

    // Keep already-issued upload IDs pollable during migration rollout.
    const { data: upload, error } = await supabaseAdmin
      .from('uploaded_images')
      .select('id, image_urls, status, error_message, ai_analysis, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Unable to read image processing job: ${error.message}`);
    if (!upload) return null;

    const timedOut = process.env.NODE_ENV === 'production' && upload.status === 'pending'
      && Date.now() - Date.parse(upload.created_at) > IMAGE_JOB_TIMEOUT_MS;
    const status = timedOut ? 'failed' : upload.status === 'pending' ? 'processing' : upload.status;

    return {
      id: upload.id,
      sourceUrl: upload.image_urls?.[0] || null,
      status,
      socialPostId: null,
      uploadedImageId: upload.id,
      attemptCount: 1,
      maxAttempts: 1,
      retryAt: null,
      error: timedOut ? IMAGE_JOB_TIMEOUT_MESSAGE : status === 'failed' ? upload.error_message : null,
      result: status === 'completed' ? upload.ai_analysis?.upload_processing?.result || null : null,
      createdAt: upload.created_at,
      updatedAt: upload.updated_at,
    };
  }
}
