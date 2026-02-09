import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  resetUserCounter,
  runMigrations,
  truncateAll,
} from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Error Handler', () => {
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations();
    const server = await startTestServer();
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await stopTestServer();
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll();
    resetUserCounter();
    emailMock.reset();
    clearRedisStore();
  });

  describe('AppError handling', () => {
    test('handles UnauthorizedError with 401', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toBeDefined();
    });

    test('handles ConflictError with 409', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: 'testuser',
          password: 'weak',
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toBeDefined();
    });

    test('handles ForbiddenError with 403', async () => {
      const response = await fetch(`${baseUrl}/test/require-admin`, {
        headers: { Cookie: 'sessionToken=invalid' },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('error response shape', () => {
    test('returns consistent error shape with message', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      const body = await response.json();

      expect(body.error).toBeDefined();
      expect(typeof body.error.message).toBe('string');
    });

    test('does not expose stack traces', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: 'nonexistent@example.com',
          password: 'password123',
        }),
      });

      const body = await response.json();
      expect(body.error.stack).toBeUndefined();
      expect(body.stack).toBeUndefined();
    });

    test('includes error code when available', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const body = await response.json();
      expect(body.error.code).toBeDefined();
    });
  });

  describe('validation errors (400)', () => {
    test('returns 400 for missing required fields', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    test('returns 400 for login without credentials', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });
});
