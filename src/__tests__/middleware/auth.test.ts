import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createExpiredSession,
  createSession,
  createTestUser,
  createVerifiedUser,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Auth Middleware', () => {
  let baseUrl: string;

  beforeAll(async () => {
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

  describe('requireAuth', () => {
    test('passes valid session and populates req.user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(user.id);
      expect(body.user.email).toBe(user.email);
    });

    test('sets req.sessionId as 20-char hex string', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      const body = await response.json();
      expect(body.sessionId).toBeDefined();
      expect(body.sessionId).toMatch(/^[a-f0-9]{20}$/);
    });

    test('rejects request without cookie with 401', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('Authentication required');
    });

    test('rejects invalid session token with 401', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: 'sessionToken=invalid-garbage-token' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('Invalid or expired session');
    });

    test('rejects expired session with 401', async () => {
      const { user } = await createVerifiedUser();
      const { token } = await createExpiredSession(user.id);

      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `sessionToken=${token}` },
      });

      expect(response.status).toBe(401);
    });

    test('same token with different User-Agent produces different sessionId', async () => {
      const { user } = await createVerifiedUser();
      const { token } = await createSession(user.id);

      const response1 = await fetch(`${baseUrl}/api/auth/me`, {
        headers: {
          Cookie: `sessionToken=${token}`,
          'User-Agent': 'Browser/1.0',
        },
      });
      const body1 = await response1.json();

      const response2 = await fetch(`${baseUrl}/api/auth/me`, {
        headers: {
          Cookie: `sessionToken=${token}`,
          'User-Agent': 'Browser/2.0',
        },
      });
      const body2 = await response2.json();

      expect(body1.sessionId).not.toBe(body2.sessionId);
    });
  });

  describe('requireEmailVerified', () => {
    test('passes verified user through', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-email-verified`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('rejects unverified user with 403', async () => {
      const { user, password } = await createTestUser({ emailVerified: false });

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-email-verified`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain('Email verification required');
    });

    test('includes user email in error details for unverified user', async () => {
      const { user, password } = await createTestUser({ emailVerified: false });

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-email-verified`, {
        headers: { Cookie: cookie },
      });

      const body = await response.json();
      expect(body.error.details).toBeDefined();
      expect(body.error.details.email).toBe(user.email);
    });

    test('includes action hint in error details', async () => {
      const { user, password } = await createTestUser({ emailVerified: false });

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-email-verified`, {
        headers: { Cookie: cookie },
      });

      const body = await response.json();
      expect(body.error.details.action).toBe('verify_email');
    });

    test('supports custom error message', async () => {
      const { user, password } = await createTestUser({ emailVerified: false });

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-email-verified-custom`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toBe('Custom verification message');
    });
  });
});
