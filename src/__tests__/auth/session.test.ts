import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createExpiredSession,
  createVerifiedUser,
  getSessionsForUser,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Session Lifecycle', () => {
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

  describe('Session Creation (on login)', () => {
    test('creates session row in DB on login', async () => {
      const { user, password } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const sessions = await getSessionsForUser(user.id);
      expect(sessions.length).toBe(1);
      expect(sessions[0].user_id).toBe(user.id);
      expect(sessions[0].token).toBeDefined();
      expect(sessions[0].expires_at).toBeDefined();
    });

    test('session token is 64 hex chars', async () => {
      const { user, password } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const sessions = await getSessionsForUser(user.id);
      expect(sessions[0].token).toMatch(/^[a-f0-9]{64}$/);
    });

    test('session expires in ~7 days', async () => {
      const { user, password } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const sessions = await getSessionsForUser(user.id);
      const expiresAt = new Date(sessions[0].expires_at);
      const now = new Date();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const diff = expiresAt.getTime() - now.getTime();

      expect(diff).toBeGreaterThan(sevenDaysMs - 60000);
      expect(diff).toBeLessThan(sevenDaysMs + 60000);
    });

    test('records IP address', async () => {
      const { user, password } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const sessions = await getSessionsForUser(user.id);
      expect(sessions[0].ip_address).toBeDefined();
      expect(sessions[0].ip_address).toContain('127.0.0.1');
    });

    test('records user agent', async () => {
      const { user, password } = await createVerifiedUser();

      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TestBrowser/1.0',
        },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const sessions = await getSessionsForUser(user.id);
      expect(sessions[0].user_agent).toBe('TestBrowser/1.0');
    });
  });

  describe('Session Validation (/auth/me)', () => {
    test('returns user for valid session', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const cookie = loginResponse.headers.get('set-cookie')!;

      const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      expect(meResponse.status).toBe(200);
      const body = await meResponse.json();
      expect(body.user.id).toBe(user.id);
      expect(body.user.email).toBe(user.email);
    });

    test('rejects request without cookie', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      expect(response.status).toBe(401);
    });

    test('rejects invalid session token', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: 'sessionToken=invalidtoken123' },
      });
      expect(response.status).toBe(401);
    });

    test('rejects expired session', async () => {
      const { user } = await createVerifiedUser();
      const { token } = await createExpiredSession(user.id);

      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `sessionToken=${token}` },
      });

      expect(response.status).toBe(401);

      const sessions = await getSessionsForUser(user.id);
      const validSessions = sessions.filter((s) => new Date(s.expires_at) > new Date());
      expect(validSessions.length).toBe(0);
    });

    test('returns sessionId derived from token + UA', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const cookie = loginResponse.headers.get('set-cookie')!;

      const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      const body = await meResponse.json();
      expect(body.sessionId).toBeDefined();
      expect(body.sessionId).toMatch(/^[a-f0-9]{20}$/);
    });
  });

  describe('Logout', () => {
    test('deletes session from DB', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const cookie = loginResponse.headers.get('set-cookie')!;
      let sessions = await getSessionsForUser(user.id);
      expect(sessions.length).toBe(1);

      await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      sessions = await getSessionsForUser(user.id);
      expect(sessions.length).toBe(0);
    });

    test('clears session cookie', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const cookie = loginResponse.headers.get('set-cookie')!;

      const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      const setCookie = logoutResponse.headers.get('set-cookie');
      expect(setCookie).toContain('sessionToken=');
      expect(setCookie).toMatch(/expires=.*1970|max-age=0/i);
    });

    test('returns success even without cookie', async () => {
      const response = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('session token no longer works after logout', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const cookie = loginResponse.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      expect(meResponse.status).toBe(401);
    });
  });

  describe('Cookie Security Attributes', () => {
    test('cookie is HttpOnly', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const setCookie = response.headers.get('set-cookie');
      expect(setCookie?.toLowerCase()).toContain('httponly');
    });

    test('cookie has SameSite attribute', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const setCookie = response.headers.get('set-cookie');
      expect(setCookie?.toLowerCase()).toContain('samesite');
    });

    test('cookie maxAge is ~7 days', async () => {
      const { user, password } = await createVerifiedUser();

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password,
        }),
      });

      const setCookie = response.headers.get('set-cookie');
      const maxAgeMatch = setCookie?.match(/max-age=(\d+)/i);
      expect(maxAgeMatch).toBeDefined();

      const maxAge = Number.parseInt(maxAgeMatch?.[1], 10);
      const sevenDaysSeconds = 7 * 24 * 60 * 60;
      expect(maxAge).toBeCloseTo(sevenDaysSeconds, -2);
    });
  });
});
