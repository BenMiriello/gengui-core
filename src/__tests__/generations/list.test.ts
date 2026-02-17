import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

describe('Generations List', () => {
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

  describe('GET /generations', () => {
    test('returns empty array when user has no generations', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generations).toEqual([]);
      expect(body.count).toBe(0);
    });

    test('returns user generations', async () => {
      const { user, password } = await createVerifiedUser();
      await createQueuedGeneration(user.id, { prompt: 'Test 1' });
      await createQueuedGeneration(user.id, { prompt: 'Test 2' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generations.length).toBe(2);
      expect(body.count).toBe(2);
    });

    test('respects limit parameter', async () => {
      const { user, password } = await createVerifiedUser();
      for (let i = 0; i < 5; i++) {
        await createQueuedGeneration(user.id, { prompt: `Test ${i}` });
      }

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations?limit=3`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generations.length).toBe(3);
      expect(body.count).toBe(3);
    });

    test('does not return other users generations', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      await createQueuedGeneration(user1.id, { prompt: 'User 1 generation' });
      await createQueuedGeneration(user2.id, { prompt: 'User 2 generation' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user1.email, password: password1 }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generations.length).toBe(1);
      expect(body.generations[0].prompt).toBe('User 1 generation');
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/generations`);
      expect(res.status).toBe(401);
    });

    test('includes all generation fields in response', async () => {
      const { user, password } = await createVerifiedUser();
      await createQueuedGeneration(user.id, {
        prompt: 'Test prompt',
        seed: 12345,
        width: 512,
        height: 768,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const gen = body.generations[0];

      expect(gen.id).toBeDefined();
      expect(gen.prompt).toBe('Test prompt');
      expect(gen.seed).toBe(12345);
      expect(gen.width).toBe(512);
      expect(gen.height).toBe(768);
      expect(gen.status).toBe('queued');
      expect(gen.createdAt).toBeDefined();
    });
  });

  describe('GET /generations/:id', () => {
    test('returns a single generation', async () => {
      const { user, password } = await createVerifiedUser();
      const generation = await createQueuedGeneration(user.id, { prompt: 'Test prompt' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/${generation.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(generation.id);
      expect(body.prompt).toBe('Test prompt');
    });

    test('returns 404 for non-existent generation', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/00000000-0000-0000-0000-000000000000`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/generations/some-id`);
      expect(res.status).toBe(401);
    });
  });
});
