import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestDocument,
  createVerifiedUser,
  resetDocumentCounter,
  resetUserCounter,
  runMigrations,
  truncateAll,
} from '../helpers';
import {
  clearPrimaryEditors,
  clearRedisStore,
  setPrimaryEditor,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Document Ownership', () => {
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
    resetDocumentCounter();
    clearRedisStore();
    clearPrimaryEditors();
  });

  describe('GET /documents/:id', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.message).toContain('Not authorized');
    });
  });

  describe('PATCH /documents/:id', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);
      setPrimaryEditor(doc.id, 'test-session');

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': 'test-session',
        },
        body: JSON.stringify({ content: 'Hacked!' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /documents/:id', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /documents/:id/copy', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Stolen Copy' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /documents/:id/modes', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/modes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ narrativeModeEnabled: true }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /documents/:id/versions', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /documents/:id/versions/:versionNumber', () => {
    test('returns 403 for document owned by another user', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: other, password: otherPassword } = await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: other.email, password: otherPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions/1`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('User Isolation', () => {
    test('user A cannot see user B documents in list', async () => {
      const { user: userA, password: passwordA } = await createVerifiedUser();
      const { user: userB } = await createVerifiedUser();

      await createTestDocument(userA.id, { title: 'A Document' });
      await createTestDocument(userB.id, { title: 'B Document' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: userA.email, password: passwordA }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Cookie: cookie },
      });

      const body = await res.json();
      expect(body.documents.length).toBe(1);
      expect(body.documents[0].title).toBe('A Document');
    });

    test('documents created by user belong to that user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const createRes = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'My Doc', content: 'Content' }),
      });

      const createBody = await createRes.json();
      expect(createBody.document.userId).toBe(user.id);
    });
  });
});
