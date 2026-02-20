import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  closeDb,
  createTestDocument,
  createVerifiedUser,
  resetDocumentCounter,
  resetUserCounter,
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

describe('Node Ownership', () => {
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
    clearStorageData();
    clearMockStoryNodes();
  });

  describe('Node access via document ownership', () => {
    test('user can access nodes on their documents', async () => {
      const { user, password } = await createVerifiedUser();
      const doc = await createTestDocument(user.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: user.id,
        type: 'character',
        name: 'My Character',
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
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.node.id).toBe(nodeId);
    });

    test('user cannot access nodes on other users documents', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: attacker, password: attackerPassword } =
        await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: owner.id,
        type: 'character',
        name: 'Protected Character',
        description: 'Secret info',
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
        body: JSON.stringify({
          emailOrUsername: attacker.email,
          password: attackerPassword,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('user cannot update nodes on other users documents', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: attacker, password: attackerPassword } =
        await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: owner.id,
        type: 'location',
        name: 'Secret Location',
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
        body: JSON.stringify({
          emailOrUsername: attacker.email,
          password: attackerPassword,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Hacked Location' }),
      });

      expect(res.status).toBe(404);
    });

    test('user cannot update style on other users nodes', async () => {
      const { user: owner } = await createVerifiedUser();
      const { user: attacker, password: attackerPassword } =
        await createVerifiedUser();
      const doc = await createTestDocument(owner.id);

      const nodeId = randomUUID();
      setMockStoryNode(nodeId, {
        id: nodeId,
        documentId: doc.id,
        userId: owner.id,
        type: 'character',
        name: 'Protected Character',
        description: null,
        aliases: [],
        primaryMediaId: null,
        stylePreset: 'original',
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: attacker.email,
          password: attackerPassword,
        }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ stylePreset: 'hacked', stylePrompt: null }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('Node isolation between users', () => {
    test('nodes with same name but different owners are isolated', async () => {
      const { user: user1, password: password1 } = await createVerifiedUser();
      const { user: user2, password: password2 } = await createVerifiedUser();
      const doc1 = await createTestDocument(user1.id);
      const doc2 = await createTestDocument(user2.id);

      const nodeId1 = randomUUID();
      const nodeId2 = randomUUID();

      setMockStoryNode(nodeId1, {
        id: nodeId1,
        documentId: doc1.id,
        userId: user1.id,
        type: 'character',
        name: 'John',
        description: 'User 1 version',
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      setMockStoryNode(nodeId2, {
        id: nodeId2,
        documentId: doc2.id,
        userId: user2.id,
        type: 'character',
        name: 'John',
        description: 'User 2 version',
        aliases: [],
        primaryMediaId: null,
        stylePreset: null,
        stylePrompt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });

      const loginRes1 = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user1.email,
          password: password1,
        }),
      });
      const cookie1 = loginRes1.headers.get('set-cookie')!;

      const loginRes2 = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user2.email,
          password: password2,
        }),
      });
      const cookie2 = loginRes2.headers.get('set-cookie')!;

      const res1 = await fetch(`${baseUrl}/api/nodes/${nodeId1}`, {
        headers: { Cookie: cookie1 },
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.node.description).toBe('User 1 version');

      const res2 = await fetch(`${baseUrl}/api/nodes/${nodeId2}`, {
        headers: { Cookie: cookie2 },
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.node.description).toBe('User 2 version');

      const crossAccess1 = await fetch(`${baseUrl}/api/nodes/${nodeId2}`, {
        headers: { Cookie: cookie1 },
      });
      expect(crossAccess1.status).toBe(404);

      const crossAccess2 = await fetch(`${baseUrl}/api/nodes/${nodeId1}`, {
        headers: { Cookie: cookie2 },
      });
      expect(crossAccess2.status).toBe(404);
    });
  });
});
