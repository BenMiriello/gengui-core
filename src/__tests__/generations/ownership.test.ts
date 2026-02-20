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
  createQueuedGeneration,
  createVerifiedUser,
  resetGenerationCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearRedisStore,
  clearStorageData,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Generations Ownership', () => {
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
    resetGenerationCounter();
    clearRedisStore();
    clearStorageData();
  });

  describe('Cross-user access prevention', () => {
    test('GET returns 404 for another users generation', async () => {
      const { user: user1 } = await createVerifiedUser();
      const { user: user2, password: password2 } = await createVerifiedUser();
      const generation = await createQueuedGeneration(user1.id, {
        prompt: 'User 1 private',
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user2.email,
          password: password2,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/${generation.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('cancel returns 404 for another users generation', async () => {
      const { user: user1 } = await createVerifiedUser();
      const { user: user2, password: password2 } = await createVerifiedUser();
      const generation = await createQueuedGeneration(user1.id, {
        prompt: 'User 1 private',
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user2.email,
          password: password2,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(
        `${baseUrl}/api/generations/${generation.id}/cancel`,
        {
          method: 'POST',
          headers: { Cookie: cookie },
        },
      );

      expect(res.status).toBe(404);
    });

    test('list only returns own generations, not others', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();

      await createQueuedGeneration(user1.id, { prompt: 'User 1 gen 1' });
      await createQueuedGeneration(user1.id, { prompt: 'User 1 gen 2' });
      await createQueuedGeneration(user2.id, { prompt: 'User 2 gen 1' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user1.email,
          password: password1,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generations.length).toBe(2);
      expect(body.generations.every((g: any) => g.userId === user1.id)).toBe(
        true,
      );
    });
  });
});
