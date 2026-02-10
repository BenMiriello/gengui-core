import { randomUUID } from 'node:crypto';
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
  clearMockStoryNodes,
  clearRedisStore,
  clearStorageData,
  setMockStoryNode,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Node CRUD', () => {
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
    clearStorageData();
    clearMockStoryNodes();
  });

  describe('GET /nodes/:id', () => {
    test('returns node by id', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'Test Character',
        description: 'A test character',
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.node.id).toBe(nodeId);
      expect(body.node.name).toBe('Test Character');
      expect(body.node.type).toBe('character');
    });

    test('returns 404 for non-existent node', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/nonexistent-node-id`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('returns 404 for other users node', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      const doc = await createTestDocument(user2.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user2.id,
        type: 'character',
        name: 'Other Users Character',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user1.email, password: password1 }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/nodes/some-id`);
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /nodes/:id', () => {
    test('updates node name', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'Original Name',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(nodeId);
    });

    test('updates node description', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'location',
        name: 'Test Location',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ description: 'A detailed description' }),
      });

      expect(res.status).toBe(200);
    });

    test('updates node aliases', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'Test Character',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ aliases: ['Alias1', 'Alias2'] }),
      });

      expect(res.status).toBe(200);
    });

    test('returns 400 for invalid input', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'Test Character',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: '' }),
      });

      expect(res.status).toBe(400);
    });

    test('returns 404 for non-existent node', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/nonexistent-node`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/nodes/some-id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /nodes/:id/style', () => {
    test('updates node style', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'Test Character',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ stylePreset: 'anime', stylePrompt: 'vibrant colors' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(nodeId);
      expect(body.stylePreset).toBe('anime');
      expect(body.stylePrompt).toBe('vibrant colors');
    });

    test('clears style with null values', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'Test Character',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: 'anime',
        stylePrompt: 'existing style',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ stylePreset: null, stylePrompt: null }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stylePreset).toBeNull();
      expect(body.stylePrompt).toBeNull();
    });

    test('returns 404 for non-existent node', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/nonexistent/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ stylePreset: 'anime', stylePrompt: null }),
      });

      expect(res.status).toBe(404);
    });

    test('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/api/nodes/some-id/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stylePreset: 'anime', stylePrompt: null }),
      });
      expect(res.status).toBe(401);
    });
  });
});
