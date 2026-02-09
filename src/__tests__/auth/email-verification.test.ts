import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createEmailVerificationToken,
  createExpiredEmailVerificationToken,
  createTestUser,
  createVerifiedUser,
  getEmailVerificationTokensForUser,
  getUserFromDb,
  resetUserCounter,
  runMigrations,
  truncateAll,
} from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Email Verification', () => {
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

  describe('POST /api/auth/verify-email', () => {
    test('verifies email with valid token and returns 200', async () => {
      const { user } = await createTestUser();
      const token = await createEmailVerificationToken(user.id, user.email);

      const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.user).toBeDefined();
      expect(body.user.emailVerified).toBe(true);
    });

    test('updates DB emailVerified flag to true', async () => {
      const { user } = await createTestUser();
      const token = await createEmailVerificationToken(user.id, user.email);

      await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const dbUser = await getUserFromDb(user.id);
      expect(dbUser.email_verified).toBe(true);
    });

    test('deletes all verification tokens for user after verification', async () => {
      const { user } = await createTestUser();
      const token = await createEmailVerificationToken(user.id, user.email);
      await createEmailVerificationToken(user.id, user.email);

      const tokensBefore = await getEmailVerificationTokensForUser(user.id);
      expect(tokensBefore.length).toBe(2);

      await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const tokensAfter = await getEmailVerificationTokensForUser(user.id);
      expect(tokensAfter.length).toBe(0);
    });

    test('rejects invalid token with 401', async () => {
      const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid-garbage-token' }),
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error.message).toContain('Invalid or expired');
    });

    test('rejects expired token with 401', async () => {
      const { user } = await createTestUser();
      const expiredToken = await createExpiredEmailVerificationToken(user.id, user.email);

      const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: expiredToken }),
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error.message).toContain('Invalid or expired');
    });

    test('token is single-use (rejects second attempt)', async () => {
      const { user } = await createTestUser();
      const token = await createEmailVerificationToken(user.id, user.email);

      const firstResponse = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(firstResponse.status).toBe(200);

      const secondResponse = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(secondResponse.status).toBe(401);
    });

    test('rejects request without token with 400', async () => {
      const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/auth/resend-verification', () => {
    test('sends new verification email for authenticated user', async () => {
      const { user, password } = await createTestUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/resend-verification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(200);
      expect(emailMock.sendVerificationEmail).toHaveBeenCalled();
    });

    test('deletes old tokens before creating new one', async () => {
      const { user, password } = await createTestUser();
      await createEmailVerificationToken(user.id, user.email);
      await createEmailVerificationToken(user.id, user.email);

      const tokensBefore = await getEmailVerificationTokensForUser(user.id);
      expect(tokensBefore.length).toBe(2);

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/resend-verification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
      });

      const tokensAfter = await getEmailVerificationTokensForUser(user.id);
      expect(tokensAfter.length).toBe(1);
    });

    test('returns alreadyVerified for verified user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/resend-verification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.alreadyVerified).toBe(true);
    });

    test('requires authentication (returns 401 without cookie)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
    });
  });
});
