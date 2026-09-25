/**
 * Production workers must use a configured secret. A fixed development-only
 * value lets local mobile + Next development servers exercise the full queue
 * without silently leaving every submitted job queued.
 */
const LOCAL_DEVELOPMENT_WORKER_SECRET = 'local-url-job-worker';

export function urlJobWorkerSecret(): string | null {
  const configured = process.env.URL_JOB_WORKER_SECRET?.trim();
  if (configured) return configured;
  return process.env.NODE_ENV === 'development' ? LOCAL_DEVELOPMENT_WORKER_SECRET : null;
}
