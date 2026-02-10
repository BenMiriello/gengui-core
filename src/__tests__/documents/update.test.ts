import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestDocument,
  createVerifiedUser,
  getDocumentById,
  resetDocumentCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearPrimaryEditors,
  clearRedisStore,
  setPrimaryEditor,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Document Update', () => {
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
    resetDocumentCounter();
    clearRedisStore();
    clearPrimaryEditors();
  });

  describe('PATCH /documents/:id', () => {
    test('updates document content when primary editor', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'Original' });
      const sessionId = 'test-session-123';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'Updated content' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.content).toBe('Updated content');

      const dbDoc = await getDocumentById(doc.id);
      expect(dbDoc.content).toBe('Updated content');
    });

    test('updates document title', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { title: 'Original Title' });
      const sessionId = 'test-session-123';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ title: 'New Title' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.title).toBe('New Title');
    });

    test('rejects update when not primary editor', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);
      setPrimaryEditor(doc.id, 'other-session');

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': 'my-session',
        },
        body: JSON.stringify({ content: 'Should fail' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Not primary editor');
    });

    test('rejects update when no primary editor set', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': 'my-session',
        },
        body: JSON.stringify({ content: 'Should fail' }),
      });

      expect(res.status).toBe(409);
    });

    test('updates mode flags', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ narrativeModeEnabled: true, mediaModeEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.narrativeModeEnabled).toBe(true);
      expect(body.document.mediaModeEnabled).toBe(true);
    });

    test('updates image dimensions', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ defaultImageWidth: 512, defaultImageHeight: 512 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.defaultImageWidth).toBe(512);
      expect(body.document.defaultImageHeight).toBe(512);
    });

    test('returns 404 for non-existent document', async () => {
      const { user, password } = await createVerifiedUser();
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const sessionId = 'test-session';
      setPrimaryEditor(nonExistentId, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${nonExistentId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'Test' }),
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /documents/:id/modes', () => {
    test('updates narrative mode without presence check', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { narrativeModeEnabled: false });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/modes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ narrativeModeEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.narrativeModeEnabled).toBe(true);
    });

    test('updates media mode', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { mediaModeEnabled: false });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/modes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ mediaModeEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.mediaModeEnabled).toBe(true);
    });

    test('updates both modes at once', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/modes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ narrativeModeEnabled: true, mediaModeEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.narrativeModeEnabled).toBe(true);
      expect(body.document.mediaModeEnabled).toBe(true);
    });

    test('returns 404 for non-existent document', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(
        `${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000/modes`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ narrativeModeEnabled: true }),
        }
      );

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id/modes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ narrativeModeEnabled: true }),
      });
      expect(res.status).toBe(401);
    });
  });
});
