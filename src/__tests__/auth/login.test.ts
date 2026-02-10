import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestUser,
  createVerifiedUser,
  getUserFromDb,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, startTestServer, stopTestServer } from '../helpers/testApp';

describe('POST /api/auth/login', () => {
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
    clearRedisStore();
  });

  describe('Happy Path', () => {
    test('logs in with email', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user.id).toBe(user.id);
      expect(body.user.email).toBe(user.email);
    });

    test('logs in with username', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.username,
          password,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user.username).toBe(user.username);
    });

    test('sets httpOnly session cookie', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).toContain('sessionToken=');
      expect(setCookie?.toLowerCase()).toContain('httponly');
    });

    test('resets failed login counter on success', async () => {
      const { user, password } = await createTestUser();

      for (let i = 0; i < 3; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailOrUsername: user.email,
            password: 'wrong-password',
          }),
        });
      }

      let dbUser = await getUserFromDb(user.id);
      expect(dbUser.failed_login_attempts).toBe(3);

      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      dbUser = await getUserFromDb(user.id);
      expect(dbUser.failed_login_attempts).toBe(0);
    });

    test('does not return password hash in response', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const body = await response.json();
      expect(body.user.passwordHash).toBeUndefined();
      expect(body.user.password_hash).toBeUndefined();
      expect(body.user.password).toBeUndefined();
    });
  });

  describe('Authentication Failures', () => {
    test('rejects wrong password', async () => {
      const { user } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password: 'wrongpassword',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toBe('Invalid credentials');
    });

    test('rejects nonexistent email with same error', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: 'nonexistent@example.com',
          password: 'anypassword',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toBe('Invalid credentials');
    });

    test('rejects nonexistent username with same error', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: 'nonexistentuser',
          password: 'anypassword',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toBe('Invalid credentials');
    });

    test('rejects missing fields', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('Account Lockout Progression', () => {
    test('first 4 failures return generic message', async () => {
      const { user } = await createTestUser();

      for (let i = 0; i < 4; i++) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailOrUsername: user.email,
            password: 'wrong-password',
          }),
        });

        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error.message).toBe('Invalid credentials');
      }

      const dbUser = await getUserFromDb(user.id);
      expect(dbUser.failed_login_attempts).toBe(4);
    });

    test('5th failure warns about remaining attempts', async () => {
      const { user } = await createTestUser();

      for (let i = 0; i < 4; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailOrUsername: user.email,
            password: 'wrong-password',
          }),
        });
      }

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password: 'wrong-password',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('attempt');
    });

    test('7th failure locks account', async () => {
      const { user } = await createTestUser();

      for (let i = 0; i < 6; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailOrUsername: user.email,
            password: 'wrong-password',
          }),
        });
      }

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password: 'wrong-password',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('locked');
      expect(body.error.message).toContain('15 minutes');
    }, 30000);

    test('locked account rejects even correct password', async () => {
      const { user, password } = await createTestUser();

      for (let i = 0; i < 7; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailOrUsername: user.email,
            password: 'wrong-password',
          }),
        });
      }

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('locked');
    }, 30000);
  });

  describe('Non-Enumeration', () => {
    test('same error format for valid email + wrong password vs nonexistent email', async () => {
      const { user } = await createVerifiedUser();

      const wrongPasswordResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password: 'wrongpassword',
        }),
      });

      const nonexistentResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: 'nonexistent@example.com',
          password: 'anypassword',
        }),
      });

      expect(wrongPasswordResponse.status).toBe(nonexistentResponse.status);

      const wrongPasswordBody = await wrongPasswordResponse.json();
      const nonexistentBody = await nonexistentResponse.json();

      expect(wrongPasswordBody.error.message).toBe(nonexistentBody.error.message);
      expect(Object.keys(wrongPasswordBody)).toEqual(Object.keys(nonexistentBody));
    });
  });
});
