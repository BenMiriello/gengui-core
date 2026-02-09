import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createExpiredPasswordResetToken,
  createPasswordResetToken,
  createSession,
  createVerifiedUser,
  getPasswordResetTokensForUser,
  getSessionsForUser,
  resetUserCounter,
  runMigrations,
  truncateAll,
} from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Password Reset', () => {
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

  describe('POST /api/auth/password-reset/request', () => {
    test('sends reset email for existing user', async () => {
      const { user } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(emailMock.sendPasswordResetEmail).toHaveBeenCalled();
      expect(emailMock.sendPasswordResetEmail).toHaveBeenCalledWith(
        user.email,
        expect.any(String)
      );
    });

    test('returns success for nonexistent email (no enumeration)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@example.com' }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(emailMock.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    test('deletes old reset tokens before creating new', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const tokensAfterFirst = await getPasswordResetTokensForUser(user.id);
      expect(tokensAfterFirst.length).toBe(1);
      const firstToken = tokensAfterFirst[0].token;

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const tokensAfterSecond = await getPasswordResetTokensForUser(user.id);
      expect(tokensAfterSecond.length).toBe(1);
      expect(tokensAfterSecond[0].token).not.toBe(firstToken);
    });

    test('token is 64 hex chars', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const tokens = await getPasswordResetTokensForUser(user.id);
      expect(tokens.length).toBe(1);
      expect(tokens[0].token).toMatch(/^[a-f0-9]{64}$/);
    });

    test('token expires in approximately 1 hour', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const tokens = await getPasswordResetTokensForUser(user.id);
      const expiresAt = new Date(tokens[0].expires_at);
      const now = new Date();
      const diffMs = expiresAt.getTime() - now.getTime();
      const oneHourMs = 60 * 60 * 1000;

      expect(diffMs).toBeGreaterThan(oneHourMs - 60000);
      expect(diffMs).toBeLessThan(oneHourMs + 60000);
    });

    test('rejects missing email with 400', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/auth/password-reset/confirm', () => {
    test('resets password with valid token', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          password: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('new password works for login after reset', async () => {
      const { user } = await createVerifiedUser();
      const newPassword = 'NewSecurePassword123!';

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: newPassword }),
      });

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password: newPassword }),
      });

      expect(loginResponse.status).toBe(200);
    });

    test('old password no longer works after reset', async () => {
      const { user, password } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'NewSecurePassword123!' }),
      });

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });

      expect(loginResponse.status).toBe(401);
    });

    test('invalidates all sessions after reset', async () => {
      const { user } = await createVerifiedUser();

      await createSession(user.id);
      await createSession(user.id);

      const sessionsBefore = await getSessionsForUser(user.id);
      expect(sessionsBefore.length).toBe(2);

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'NewSecurePassword123!' }),
      });

      const sessionsAfter = await getSessionsForUser(user.id);
      expect(sessionsAfter.length).toBe(0);
    });

    test('deletes all reset tokens for user after reset', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      const tokensBefore = await getPasswordResetTokensForUser(user.id);
      expect(tokensBefore.length).toBe(1);

      await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'NewSecurePassword123!' }),
      });

      const tokensAfter = await getPasswordResetTokensForUser(user.id);
      expect(tokensAfter.length).toBe(0);
    });

    test('rejects invalid token with 401', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'invalid-garbage-token',
          password: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(401);
    });

    test('rejects expired token with 401', async () => {
      const { user } = await createVerifiedUser();
      const expiredToken = await createExpiredPasswordResetToken(user.id);

      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: expiredToken,
          password: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('expired');
    });

    test('token is single-use (second attempt fails)', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      const firstResponse = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'NewSecurePassword123!' }),
      });
      expect(firstResponse.status).toBe(200);

      const secondResponse = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'AnotherPassword456!' }),
      });
      expect(secondResponse.status).toBe(401);
    });

    test('validates new password strength (rejects weak password)', async () => {
      const { user } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });

      const token = emailMock.getLastPasswordResetToken();

      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'weak' }),
      });

      expect(response.status).toBe(409);
    });

    test('rejects missing token with 400', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'NewSecurePassword123!' }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects missing password with 400', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'some-token' }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects empty body with 400', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });
});
