/**
 * Error sanitization for user-facing error messages.
 *
 * Prevents internal implementation details from leaking to users while
 * preserving actionable information.
 */

const INTERNAL_ERROR_PATTERNS = [
  // File paths (any absolute or relative path)
  /\/[^\s]*\/[^\s]*\.(?:js|ts|jsx|tsx|mjs|cjs)/gi,
  /\\[^\s]*\\[^\s]*\.(?:js|ts|jsx|tsx|mjs|cjs)/gi, // Windows paths

  // Module resolution errors
  /cannot find module/gi,
  /module not found/gi,
  /err_module_not_found/gi,
  /err_unknown_file_extension/gi,
  /failed to resolve/gi,

  // Package/dependency names in errors
  /node_modules/gi,
  /voyageai|@[\w-]+\/[\w-]+/gi,

  // Stack traces
  /^\s+at\s+.*$/gim,
  /Error:\s+at\s+.*$/gim,
  /Trace:/gim,

  // Internal service/component names
  /\b(?:pipeline|worker|service|provider|queue|redis|postgres|falkordb|drizzle|ioredis)\b/gi,

  // Database internals
  /\bcolumn\s+['"`]?\w+['"`]?/gi,
  /\btable\s+['"`]?\w+['"`]?/gi,
  /\bpg_|postgres|psql\b/gi,

  // Node.js internals
  /\bnode:.*$/gim,
  /\binternal\/.*$/gim,
  /process\..*$/gim,
];

const USER_ERROR_KEYWORDS = [
  'too short',
  'too long',
  'empty',
  'minimum',
  'maximum',
  'characters',
  'not found',
  'unauthorized',
  'permission',
  'unable to augment',
  'filtered',
  'inappropriate',
  'please add',
  'please try',
  'invalid format',
  'missing required',
];

/**
 * Determines if an error message should be shown to users as-is.
 */
function isUserFacingError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return USER_ERROR_KEYWORDS.some((keyword) => lowerMessage.includes(keyword));
}

/**
 * Checks if an error message contains internal details that should be hidden.
 */
function containsInternalDetails(message: string): boolean {
  return INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Categorizes error type based on message content.
 */
function categorizeError(message: string): 'user' | 'transient' | 'internal' {
  const lowerMessage = message.toLowerCase();

  // Internal errors (module resolution, dependencies, system errors) - check FIRST
  // These should never be shown to users, even if they contain user-facing keywords
  if (
    lowerMessage.includes('cannot find module') ||
    lowerMessage.includes('module not found') ||
    lowerMessage.includes('node_modules') ||
    lowerMessage.includes('err_module') ||
    lowerMessage.includes('node:') ||
    containsInternalDetails(message)
  ) {
    return 'internal';
  }

  // User errors (validation, input issues)
  if (isUserFacingError(message)) {
    return 'user';
  }

  // Transient errors (retry-able)
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('temporarily unavailable') ||
    lowerMessage.includes('quota') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('network')
  ) {
    return 'transient';
  }

  // Everything else is internal
  return 'internal';
}

/**
 * Sanitize an error for user display.
 *
 * User errors: passed through as-is (if no internal details leaked)
 * Transient errors: generic retry message
 * Internal errors: generic failure message
 *
 * NEVER exposes: file paths, module names, stack traces, service names, or internal state.
 */
export function sanitizeError(error: unknown): string {
  // Extract message safely
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else if (error && typeof error === 'object' && 'message' in error) {
    message = String(error.message);
  } else {
    message = 'Unknown error';
  }

  // Categorize the error
  const category = categorizeError(message);

  // Return user-facing message based on category
  let sanitized: string;
  switch (category) {
    case 'user':
      // User-facing validation errors can be shown as-is, but double-check
      // for any internal details that might have leaked in
      if (containsInternalDetails(message)) {
        sanitized = 'The request could not be completed. Please try again.';
      } else {
        sanitized = message;
      }
      break;

    case 'transient':
      sanitized =
        'The service is temporarily unavailable. Please try again in a moment.';
      break;

    default:
      sanitized = 'Analysis could not be completed. Please try again.';
      break;
  }

  // Final safety check: ensure no internal details leak through
  // Skip check for known-safe generic messages
  const knownSafeMessages = [
    'Analysis could not be completed. Please try again.',
    'The service is temporarily unavailable. Please try again in a moment.',
    'The request could not be completed. Please try again.',
    'An error occurred. Please try again.',
  ];

  if (
    !knownSafeMessages.includes(sanitized) &&
    containsInternalDetails(sanitized)
  ) {
    return 'An error occurred. Please try again.';
  }

  return sanitized;
}

/**
 * Sanitize error for logging (keeps full details).
 * Use this to log the real error while showing sanitized version to users.
 */
export function getErrorForLogging(error: unknown): {
  message: string;
  stack?: string;
  name?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
    };
  }

  return {
    message: String(error),
  };
}
