import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestDocument,
  createTestUser,
  createVerifiedUser,
  getGenerationsForUser,
  resetDocumentCounter,
  resetGenerationCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, clearStorageData, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Generations Create', () => {
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
    resetDocumentCounter();
    clearRedisStore();
    clearStorageData();
  });

  describe('POST /generations', () => {
    test('creates a generation with valid prompt', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'A beautiful sunset over mountains' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe('queued');
      expect(body.prompt).toBe('A beautiful sunset over mountains');
      expect(body.seed).toBeDefined();
      expect(body.width).toBe(1024);
      expect(body.height).toBe(1024);
      expect(body.createdAt).toBeDefined();

      const generations = await getGenerationsForUser(user.id);
      expect(generations.length).toBe(1);
    });

    test('creates a generation with custom dimensions', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'A test image', width: 512, height: 512 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.width).toBe(512);
      expect(body.height).toBe(512);
    });

    test('creates a generation with custom seed', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'A test image', seed: 12345 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.seed).toBe(12345);
    });

    test('associates generation with document when documentId provided', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          prompt: 'A test image',
          documentId: doc.id,
          startChar: 0,
          endChar: 10,
          sourceText: 'Test text',
        }),
      });

      expect(res.status).toBe(201);
    });

    test('returns 400 for empty prompt', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: '' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 for prompt exceeding max length', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const longPrompt = 'a'.repeat(10001);
      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: longPrompt }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 for dimensions below minimum', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'Test', width: 100, height: 100 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 for dimensions above maximum', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'Test', width: 5000, height: 5000 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 for invalid documentId format', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'Test', documentId: 'not-a-uuid' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'A test image' }),
      });

      expect(res.status).toBe(401);
    });

    test('returns 403 when email not verified', async () => {
      const { user, password } = await createTestUser({ emailVerified: false });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'A test image' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.message).toContain('Email verification required');
    });

    test('returns 400 for negative seed', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ prompt: 'Test', seed: -1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
