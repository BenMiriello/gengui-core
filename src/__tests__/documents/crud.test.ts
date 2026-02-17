import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestDocument,
  createVerifiedUser,
  getDocumentById,
  getDocumentsForUser,
  resetDocumentCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Document CRUD', () => {
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
  });

  describe('GET /documents', () => {
    test('returns empty array when user has no documents', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.documents).toEqual([]);
    });

    test('returns user documents ordered by updatedAt desc', async () => {
      const { user, password } = await createVerifiedUser();
      const doc1 = await createTestDocument(user.id, { title: 'First' });
      const doc2 = await createTestDocument(user.id, { title: 'Second' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.documents.length).toBe(2);
      expect(body.documents[0].id).toBe(doc2.id);
      expect(body.documents[1].id).toBe(doc1.id);
    });

    test('excludes deleted documents', async () => {
      const { user, password } = await createVerifiedUser();
      await createTestDocument(user.id, { title: 'Active' });
      const deletedDoc = await createTestDocument(user.id, { title: 'Deleted' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${deletedDoc.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Cookie: cookie },
      });

      const body = await res.json();
      expect(body.documents.length).toBe(1);
      expect(body.documents[0].title).toBe('Active');
    });

    test('does not include other users documents', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      await createTestDocument(user1.id, { title: 'User1 Doc' });
      await createTestDocument(user2.id, { title: 'User2 Doc' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user1.email, password: password1 }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Cookie: cookie },
      });

      const body = await res.json();
      expect(body.documents.length).toBe(1);
      expect(body.documents[0].title).toBe('User1 Doc');
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /documents/:id', () => {
    test('returns document by id', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id, { title: 'My Doc', content: 'Hello world' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.id).toBe(doc.id);
      expect(body.document.title).toBe('My Doc');
      expect(body.document.content).toBe('Hello world');
    });

    test('returns 404 for non-existent document', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('returns 404 for deleted document', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /documents', () => {
    test('creates document with title and content', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'New Doc', content: 'Some content' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.document.id).toBeDefined();
      expect(body.document.title).toBe('New Doc');
      expect(body.document.content).toBe('Some content');

      const docs = await getDocumentsForUser(user.id);
      expect(docs.length).toBe(1);
    });

    test('auto-generates title from content when not provided', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: 'This is my document content here' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.document.title).toBe('This is my document content');
    });

    test('uses Untitled Document for empty content', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: '' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.document.title).toBe('Untitled Document');
    });

    test('returns 400 when content is missing', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'No Content' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toBe('Content is required');
    });

    test('initializes with user default image dimensions', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Doc', content: 'Content' }),
      });

      const body = await res.json();
      expect(body.document.defaultImageWidth).toBe(1024);
      expect(body.document.defaultImageHeight).toBe(1024);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test', content: 'Content' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /documents/:id', () => {
    test('soft deletes document', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const dbDoc = await getDocumentById(doc.id);
      expect(dbDoc.deleted_at).not.toBeNull();
    });

    test('returns 404 for non-existent document', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /documents/:id/copy', () => {
    test('copies document with new title', async () => {
      const { user, password } = await createVerifiedUser();
      const original = await createTestDocument(user.id, {
        title: 'Original',
        content: 'Original content',
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${original.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Copy of Original' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.document.id).not.toBe(original.id);
      expect(body.document.title).toBe('Copy of Original');
      expect(body.document.content).toBe('Original content');

      const docs = await getDocumentsForUser(user.id);
      expect(docs.length).toBe(2);
    });

    test('uses Untitled as default title', async () => {
      const { user, password } = await createVerifiedUser();
      const original = await createTestDocument(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${original.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.document.title).toBe('Untitled');
    });

    test('resets mode flags on copy', async () => {
      const { user, password } = await createVerifiedUser();
      const original = await createTestDocument(user.id, {
        narrativeModeEnabled: true,
        mediaModeEnabled: true,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/documents/${original.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Copy' }),
      });

      const body = await res.json();
      expect(body.document.narrativeModeEnabled).toBe(false);
      expect(body.document.mediaModeEnabled).toBe(false);
    });

    test('returns 404 for non-existent source', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(
        `${baseUrl}/api/documents/00000000-0000-0000-0000-000000000000/copy`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ title: 'Copy' }),
        }
      );

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/documents/some-id/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Copy' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
