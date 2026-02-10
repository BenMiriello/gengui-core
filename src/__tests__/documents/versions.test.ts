import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestDocument,
  createVerifiedUser,
  getDocumentById,
  getDocumentVersions,
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

describe('Document Versioning', () => {
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

  describe('Version Creation', () => {
    test('creates version when content is updated', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'Original content' });
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'Updated content' }),
      });

      const versions = await getDocumentVersions(doc.id);
      expect(versions.length).toBe(1);
      expect(versions[0].content).toBe('Original content');
      expect(versions[0].version_number).toBe(1);
    });

    test('increments version number on each update', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'v0' });
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'v1' }),
      });

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'v2' }),
      });

      const versions = await getDocumentVersions(doc.id);
      expect(versions.length).toBe(2);
      expect(versions[0].version_number).toBe(2);
      expect(versions[1].version_number).toBe(1);

      const dbDoc = await getDocumentById(doc.id);
      expect(dbDoc.current_version).toBe(2);
    });

    test('does not create version when content unchanged', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'Same content' });
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'First update' }),
      });

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'First update' }),
      });

      const versions = await getDocumentVersions(doc.id);
      expect(versions.length).toBe(2);
    });

    test('does not create version for non-content updates', async () => {
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

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ title: 'New Title' }),
      });

      const versions = await getDocumentVersions(doc.id);
      expect(versions.length).toBe(0);
    });
  });

  describe('GET /documents/:id/versions', () => {
    test('returns empty array for new document', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.versions).toEqual([]);
    });

    test('returns versions ordered by version number desc', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'v0' });
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'v1' }),
      });

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'v2' }),
      });

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.versions.length).toBe(2);
      expect(body.versions[0].versionNumber).toBe(2);
      expect(body.versions[1].versionNumber).toBe(1);
    });

    test('respects limit parameter', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'v0' });
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      for (let i = 1; i <= 5; i++) {
        await fetch(`${baseUrl}/api/documents/${doc.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'x-tab-id': sessionId,
          },
          body: JSON.stringify({ content: `v${i}` }),
        });
      }

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions?limit=2`, {
        headers: { Cookie: cookie },
      });

      const body = await res.json();
      expect(body.versions.length).toBe(2);
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
        `${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000/versions`,
        {
          headers: { Cookie: cookie },
        }
      );

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id/versions`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /documents/:id/versions/:versionNumber', () => {
    test('returns specific version', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { content: 'Original' });
      const sessionId = 'test-session';
      setPrimaryEditor(doc.id, sessionId);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'x-tab-id': sessionId,
        },
        body: JSON.stringify({ content: 'Updated' }),
      });

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions/1`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version.versionNumber).toBe(1);
      expect(body.version.content).toBe('Original');
    });

    test('returns 404 for non-existent version number', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}/versions/999`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
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
        `${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000/versions/1`,
        {
          headers: { Cookie: cookie },
        }
      );

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id/versions/1`);
      expect(res.status).toBe(401);
    });
  });
});
