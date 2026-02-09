import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createVerifiedUser,
  resetUserCounter,
  runMigrations,
  truncateAll,
} from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('User Preferences', () => {
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

  describe('GET /api/auth/preferences', () => {
    test('returns preferences for authenticated user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.preferences).toBeDefined();
      expect(body.preferences.defaultImageWidth).toBeDefined();
      expect(body.preferences.defaultImageHeight).toBeDefined();
    });

    test('returns default values for new user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        headers: { Cookie: cookie },
      });

      const body = await response.json();
      expect(body.preferences.hiddenPresetIds).toEqual([]);
    });

    test('requires authentication (returns 401 without cookie)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/preferences`);

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/auth/preferences', () => {
    test('updates valid preferences', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          defaultImageWidth: 1024,
          defaultImageHeight: 1024,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.preferences.defaultImageWidth).toBe(1024);
      expect(body.preferences.defaultImageHeight).toBe(1024);
    });

    test('updates hiddenPresetIds', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const hiddenIds = ['preset-1', 'preset-2'];

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ hiddenPresetIds: hiddenIds }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.preferences.hiddenPresetIds).toEqual(hiddenIds);
    });

    test('updates defaultStylePreset', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ defaultStylePreset: 'my-preset-id' }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.preferences.defaultStylePreset).toBe('my-preset-id');
    });

    test('persists preferences across requests', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          defaultImageWidth: 512,
          defaultImageHeight: 512,
        }),
      });

      const getResponse = await fetch(`${baseUrl}/api/auth/preferences`, {
        headers: { Cookie: cookie },
      });

      const body = await getResponse.json();
      expect(body.preferences.defaultImageWidth).toBe(512);
      expect(body.preferences.defaultImageHeight).toBe(512);
    });

    test('rejects empty update with 409', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('No preferences to update');
    });

    test('requires authentication (returns 401 without cookie)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultImageWidth: 1024 }),
      });

      expect(response.status).toBe(401);
    });

    test('each user has isolated preferences', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2, password: password2 } = await createVerifiedUser();

      const login1Response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user1.email, password: password1 }),
      });
      const cookie1 = login1Response.headers.get('set-cookie') ?? '';

      const login2Response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user2.email, password: password2 }),
      });
      const cookie2 = login2Response.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
        },
        body: JSON.stringify({ defaultStylePreset: 'user1-preset' }),
      });

      await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie2,
        },
        body: JSON.stringify({ defaultStylePreset: 'user2-preset' }),
      });

      const get1Response = await fetch(`${baseUrl}/api/auth/preferences`, {
        headers: { Cookie: cookie1 },
      });
      const body1 = await get1Response.json();
      expect(body1.preferences.defaultStylePreset).toBe('user1-preset');

      const get2Response = await fetch(`${baseUrl}/api/auth/preferences`, {
        headers: { Cookie: cookie2 },
      });
      const body2 = await get2Response.json();
      expect(body2.preferences.defaultStylePreset).toBe('user2-preset');
    });
  });
});
