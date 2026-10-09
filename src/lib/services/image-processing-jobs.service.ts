import { supabaseAdmin } from '@/lib/supabase';

// Image analysis runs within process-url's 300-second invocation. A terminated
// invocation must not leave mobile polling a pending upload indefinitely.
const IMAGE_JOB_TIMEOUT_MS = 6 * 60_000;
const IMAGE_JOB_TIMEOUT_MESSAGE = 'Image processing timed out. Please upload the images again.';

export class ImageProcessingJobsService {
  /** Upload IDs are image job IDs; only the verified upload owner can poll. */
  static async getJobForUser(id: string, userId: string) {
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
