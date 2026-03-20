import { BadRequestError, ForbiddenError } from './errors';

/**
 * Extract a route parameter as a string, throwing if it's an array or missing.
 * Express 5 types params as `string | string[]` to support wildcard routes.
 * This helper validates we got a single string value.
 */
export function parseStringParam(
  value: string | string[] | undefined,
  paramName: string = 'parameter',
): string {
  if (value === undefined) {
    throw new BadRequestError(`Missing required parameter: ${paramName}`);
  }
  if (Array.isArray(value)) {
    throw new BadRequestError(`Invalid parameter format: ${paramName}`);
  }
  return value;
}

export function validateOwnership(
  resource: { userId: string } | null | undefined,
  currentUserId: string,
  resourceName: string = 'Resource',
): asserts resource is { userId: string } {
  if (!resource) {
    throw new ForbiddenError(`${resourceName} not found`);
  }

  if (resource.userId !== currentUserId) {
    const lower = resourceName.toLowerCase();
    throw new ForbiddenError(
      `You do not have permission to access this ${lower}`,
    );
  }
}

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
  strength: 'weak' | 'medium' | 'strong';
}

export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (password.length < 16) {
    const hasSpecialChar = /[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/.test(password);
    if (!hasSpecialChar) {
      errors.push(
        'Password under 16 characters must contain a special character',
      );
    }
  }

  const strength =
    password.length >= 16
      ? 'strong'
      : password.length >= 12
        ? 'medium'
        : 'weak';

  return {
    valid: errors.length === 0,
    errors,
    strength,
  };
}

export interface UsernameValidationResult {
  valid: boolean;
  error?: string;
}

export function validateUsername(username: string): UsernameValidationResult {
  if (username.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }

  if (username.length > 50) {
    return { valid: false, error: 'Username must be 50 characters or less' };
  }

  const validUsernamePattern = /^[a-zA-Z0-9_]+$/;
  if (!validUsernamePattern.test(username)) {
    return {
      valid: false,
      error: 'Username can only contain letters, numbers, and underscores',
    };
  }

  return { valid: true };
}

export function validateEmail(email: string): boolean {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(email);
}
