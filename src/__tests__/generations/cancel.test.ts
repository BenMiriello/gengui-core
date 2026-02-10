import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createCancelledGeneration,
  createCompletedGeneration,
  createFailedGeneration,
  createQueuedGeneration,
  createVerifiedUser,
  getGenerationById,
  resetGenerationCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, clearStorageData, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Generations Cancel', () => {
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

  describe('POST /generations/:id/cancel', () => {
    test('successfully cancels a queued generation', async () => {
      const { user, password } = await createVerifiedUser();
      const generation = await createQueuedGeneration(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/${generation.id}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cancelled).toBe(true);

      const updated = await getGenerationById(generation.id);
      expect(updated.cancelled_at).not.toBeNull();
      expect(updated.status).toBe('failed');
      expect(updated.error).toBe('Cancelled by user');
    });

    test('returns 409 for already completed generation', async () => {
      const { user, password } = await createVerifiedUser();
      const generation = await createCompletedGeneration(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/${generation.id}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('ALREADY_COMPLETED');
    });

    test('returns 409 for already failed generation', async () => {
      const { user, password } = await createVerifiedUser();
      const generation = await createFailedGeneration(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/${generation.id}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('ALREADY_FAILED');
    });

    test('is idempotent for already cancelled generation', async () => {
      const { user, password } = await createVerifiedUser();
      const generation = await createCancelledGeneration(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/${generation.id}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cancelled).toBe(true);
      expect(body.alreadyCancelled).toBe(true);
    });

    test('returns 404 for non-existent generation', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations/00000000-0000-0000-0000-000000000000/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/generations/some-id/cancel`, {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });
  });
});
