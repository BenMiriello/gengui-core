import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  closeDb,
  createTestMedia,
  createVerifiedUser,
  resetMediaCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearRedisStore,
  clearStorageData,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Media Download', () => {
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
    resetMediaCounter();
    clearRedisStore();
    clearStorageData();
  });

  describe('GET /media/:id', () => {
    test('returns media metadata by id', async () => {
      const { user, password } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media/${media.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(media.id);
      expect(body.mimeType).toBe('image/png');
    });

    test('returns 404 for non-existent media', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(
        `${baseUrl}/api/media/00000000-0000-0000-0000-000000000000`,
        {
          headers: { Cookie: cookie },
        },
      );

      expect(res.status).toBe(404);
    });

    test('returns 404 for other user media', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      const media = await createTestMedia(user2.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user1.email,
          password: password1,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media/${media.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/media/some-id`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /media/:id/url', () => {
    test('returns signed download URL', async () => {
      const { user, password } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media/${media.id}/url`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain('https://');
      expect(body.expiresIn).toBeDefined();
    });

    test('returns 404 for non-existent media', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(
        `${baseUrl}/api/media/00000000-0000-0000-0000-000000000000/url`,
        {
          headers: { Cookie: cookie },
        },
      );

      expect(res.status).toBe(404);
    });

    test('returns 404 for other user media', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      const media = await createTestMedia(user2.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user1.email,
          password: password1,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media/${media.id}/url`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('accepts type query param for thumbnail', async () => {
      const { user, password } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(
        `${baseUrl}/api/media/${media.id}/url?type=thumb`,
        {
          headers: { Cookie: cookie },
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain('https://');
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/media/some-id/url`);
      expect(res.status).toBe(401);
    });
  });
});
