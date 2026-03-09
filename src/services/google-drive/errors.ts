export class DriveConnectionExpiredError extends Error {
  constructor() {
    super('Google Drive session expired. Please reconnect.');
    this.name = 'DriveConnectionExpiredError';
  }
}

export function mapDriveErrorToMessage(error: unknown): string {
  if (error instanceof DriveConnectionExpiredError) {
    return error.message;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    if (msg.includes('401') || msg.includes('invalid_grant')) {
      return 'Google Drive session expired. Please reconnect.';
    }
    if (
      msg.includes('403') ||
      msg.includes('rate limit') ||
      msg.includes('quota')
    ) {
      return 'Too many requests. Please wait a moment and try again.';
    }
    if (msg.includes('404')) {
      return 'File not found. It may have been deleted or moved.';
    }
    if (msg.includes('413') || msg.includes('too large')) {
      return 'File exceeds size limit (10MB max).';
    }
    if (msg.includes('network') || msg.includes('fetch failed')) {
      return 'Connection failed. Check your network and try again.';
    }
    if (msg.includes('unsupported') || msg.includes('mime')) {
      return 'Format not supported. Try Google Docs, DOCX, PDF, TXT, or MD.';
    }
  }

  return 'An unexpected error occurred. Please try again.';
}
