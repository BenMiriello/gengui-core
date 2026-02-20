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

describe('Media Upload', () => {
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

  describe('POST /media', () => {
    test('uploads a file successfully', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const formData = new FormData();
      const fileContent = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const file = new Blob([fileContent], { type: 'image/png' });
      formData.append('file', file, 'test.png');

      const res = await fetch(`${baseUrl}/api/media`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: formData,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.storageKey).toBeDefined();
      expect(body.url).toContain('https://');
      expect(body.mimeType).toBe('image/png');

      const mediaList = await getMediaForUser(user.id);
      expect(mediaList.length).toBe(1);
    });

    test('returns 400 when no file is provided', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const formData = new FormData();

      const res = await fetch(`${baseUrl}/api/media`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: formData,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('NO_FILE');
    });

    test('requires authentication', async () => {
      const formData = new FormData();
      const file = new Blob(['test'], { type: 'image/png' });
      formData.append('file', file, 'test.png');

      const res = await fetch(`${baseUrl}/api/media`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(401);
    });

    test('detects duplicate upload and returns existing media', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const fileContent = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
      ]);
      const file = new Blob([fileContent], { type: 'image/png' });

      const formData1 = new FormData();
      formData1.append('file', file, 'test1.png');

      const res1 = await fetch(`${baseUrl}/api/media`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: formData1,
      });

      expect(res1.status).toBe(201);
      const body1 = await res1.json();

      const formData2 = new FormData();
      formData2.append('file', file, 'test2.png');

      const res2 = await fetch(`${baseUrl}/api/media`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: formData2,
      });

      expect(res2.status).toBe(201);
      const body2 = await res2.json();

      expect(body2.id).toBe(body1.id);

      const mediaList = await getMediaForUser(user.id);
      expect(mediaList.length).toBe(1);
    });
  });

  describe('GET /media', () => {
    test('returns empty array when user has no media', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.media).toEqual([]);
      expect(body.count).toBe(0);
    });

    test('returns user media ordered by createdAt desc', async () => {
      const { user, password } = await createVerifiedUser();
      const media1 = await createTestMedia(user.id);
      const media2 = await createTestMedia(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.media.length).toBe(2);
      expect(body.media[0].id).toBe(media2.id);
      expect(body.media[1].id).toBe(media1.id);
    });

    test('does not return other users media', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      await createTestMedia(user1.id);
      await createTestMedia(user2.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user1.email,
          password: password1,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/media`, {
        headers: { Cookie: cookie },
      });

      const body = await res.json();
      expect(body.media.length).toBe(1);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/media`);
      expect(res.status).toBe(401);
    });
  });
});
