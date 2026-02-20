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
  getMediaById,
  getMediaForUser,
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

describe('Media Delete', () => {
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

  describe('DELETE /media/:id', () => {
    test('soft deletes media', async () => {
      const { user, password } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media/${media.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Media deleted');
      expect(body.id).toBe(media.id);

      const dbMedia = await getMediaById(media.id);
      expect(dbMedia.deleted_at).not.toBeNull();
    });

    test('deleted media does not appear in list', async () => {
      const { user, password } = await createVerifiedUser();
      await createTestMedia(user.id);
      const mediaToDelete = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/media/${mediaToDelete.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      const mediaList = await getMediaForUser(user.id);
      expect(mediaList.length).toBe(1);
      expect(mediaList.some((m: any) => m.id === mediaToDelete.id)).toBe(false);
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
          method: 'DELETE',
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
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);

      const dbMedia = await getMediaById(media.id);
      expect(dbMedia.deleted_at).toBeNull();
    });

    test('returns 404 for already deleted media', async () => {
      const { user, password } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/media/${media.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      const res = await fetch(`${baseUrl}/api/media/${media.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/media/some-id`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });
});
