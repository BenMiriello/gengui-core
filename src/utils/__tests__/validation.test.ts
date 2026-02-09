import { describe, expect, test } from 'bun:test';
import { ForbiddenError } from '../errors';
import {
  validateEmail,
  validateOwnership,
  validatePassword,
  validateUsername,
} from '../validation';

describe('validatePassword', () => {
  test('rejects empty string', () => {
    const result = validatePassword('');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('8'))).toBe(true);
  });

  test('rejects passwords under 8 characters', () => {
    const result = validatePassword('Ab1!xyz');
    expect(result.valid).toBe(false);
  });

  test('accepts 8+ chars with special character', () => {
    const result = validatePassword('Abcdefg!');
    expect(result.valid).toBe(true);
  });

  test('rejects 8-15 chars without special character', () => {
    const result = validatePassword('Abcdefghijk');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('special'))).toBe(true);
  });

  test('accepts 16+ chars without special character', () => {
    const result = validatePassword('Abcdefghijklmnop');
    expect(result.valid).toBe(true);
  });

  test('returns strength: weak for under 12 chars', () => {
    const result = validatePassword('Abcdefg!');
    expect(result.strength).toBe('weak');
  });

  test('returns strength: medium for 12-15 chars', () => {
    const result = validatePassword('Abcdefghijk!');
    expect(result.strength).toBe('medium');
  });

  test('returns strength: strong for 16+ chars', () => {
    const result = validatePassword('Abcdefghijklmnop');
    expect(result.strength).toBe('strong');
  });

  test('handles various special characters', () => {
    const specialChars = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+'];
    for (const char of specialChars) {
      const result = validatePassword(`Abcdefg${char}`);
      expect(result.valid).toBe(true);
    }
  });
});

describe('validateUsername', () => {
  test('rejects usernames under 3 characters', () => {
    const result = validateUsername('ab');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('3');
  });

  test('rejects usernames over 50 characters', () => {
    const result = validateUsername('a'.repeat(51));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('50');
  });

  test('rejects special characters', () => {
    const result = validateUsername('user@name');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('letters, numbers, and underscores');
  });

  test('rejects spaces', () => {
    const result = validateUsername('user name');
    expect(result.valid).toBe(false);
  });

  test('accepts letters, numbers, and underscores', () => {
    const result = validateUsername('user_123');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('accepts exactly 3 characters', () => {
    const result = validateUsername('abc');
    expect(result.valid).toBe(true);
  });

  test('accepts exactly 50 characters', () => {
    const result = validateUsername('a'.repeat(50));
    expect(result.valid).toBe(true);
  });

  test('accepts uppercase letters', () => {
    const result = validateUsername('UserName123');
    expect(result.valid).toBe(true);
  });

  test('rejects hyphens', () => {
    const result = validateUsername('user-name');
    expect(result.valid).toBe(false);
  });

  test('rejects dots', () => {
    const result = validateUsername('user.name');
    expect(result.valid).toBe(false);
  });
});

describe('validateEmail', () => {
  test('accepts valid email', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });

  test('rejects email without @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });

  test('rejects email without domain', () => {
    expect(validateEmail('user@')).toBe(false);
  });

  test('rejects email with spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
  });

  test('rejects email without TLD', () => {
    expect(validateEmail('user@example')).toBe(false);
  });

  test('accepts email with subdomain', () => {
    expect(validateEmail('user@mail.example.com')).toBe(true);
  });

  test('accepts email with plus sign', () => {
    expect(validateEmail('user+tag@example.com')).toBe(true);
  });

  test('accepts email with dots in local part', () => {
    expect(validateEmail('user.name@example.com')).toBe(true);
  });

  test('rejects email starting with space', () => {
    expect(validateEmail(' user@example.com')).toBe(false);
  });

  test('rejects email ending with space', () => {
    expect(validateEmail('user@example.com ')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateEmail('')).toBe(false);
  });

  test('rejects multiple @ symbols', () => {
    expect(validateEmail('user@@example.com')).toBe(false);
  });
});

describe('validateOwnership', () => {
  test('passes when userId matches', () => {
    const resource = { userId: 'user-123' };
    expect(() => validateOwnership(resource, 'user-123')).not.toThrow();
  });

  test('throws ForbiddenError when userId differs', () => {
    const resource = { userId: 'user-123' };
    expect(() => validateOwnership(resource, 'user-456')).toThrow(ForbiddenError);
  });

  test('throws ForbiddenError when resource is null', () => {
    expect(() => validateOwnership(null, 'user-123')).toThrow(ForbiddenError);
  });

  test('throws ForbiddenError when resource is undefined', () => {
    expect(() => validateOwnership(undefined, 'user-123')).toThrow(ForbiddenError);
  });

  test('includes resource name in error message for null resource', () => {
    try {
      validateOwnership(null, 'user-123', 'Document');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).message).toContain('Document');
    }
  });

  test('includes resource name in permission error', () => {
    const resource = { userId: 'user-123' };
    try {
      validateOwnership(resource, 'user-456', 'Document');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).message).toContain('document');
    }
  });

  test('works with additional resource properties', () => {
    const resource = { userId: 'user-123', title: 'My Doc', content: 'Hello' };
    expect(() => validateOwnership(resource, 'user-123')).not.toThrow();
  });
});
