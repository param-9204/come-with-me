export type ProcessingErrorDetails = {
  message: string;
  code: string | null;
  retryable: boolean;
  httpStatus: number;
};

const FACEBOOK_REEL_NOT_PUBLIC = /Facebook did not expose public video data for this Reel/i;

export function processingErrorDetails(error: unknown): ProcessingErrorDetails {
  const message = error instanceof Error
    ? error.message
    : String(error || 'Processing failed');

  if (FACEBOOK_REEL_NOT_PUBLIC.test(message)) {
    return {
      message,
      code: 'facebook_reel_not_public',
      retryable: false,
      httpStatus: 422,
    };
  }

  return {
    message,
    code: null,
    retryable: true,
    httpStatus: 500,
  };
}
