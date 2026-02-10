import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createAdminUser,
  createCompletedGeneration,
  createFailedGeneration,
  createQueuedGeneration,
  createTestUser,
  createVerifiedUser,
  resetGenerationCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, clearStorageData, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Admin Users', () => {
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

  describe('GET /admin/users', () => {
    test('lists all users for admin', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      await createVerifiedUser();
      await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.length).toBe(3);
      expect(body.pagination.total).toBe(3);
    });

    test('filters by search term', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      await createTestUser({ email: 'alice@example.com', username: 'alice' });
      await createTestUser({ email: 'bob@example.com', username: 'bob' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users?search=alice`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.length).toBe(1);
      expect(body.users[0].username).toBe('alice');
    });

    test('filters by role', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      await createVerifiedUser();
      await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users?role=admin`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.every((u: any) => u.role === 'admin')).toBe(true);
    });

    test('filters by emailVerified', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      await createTestUser({ emailVerified: true });
      await createTestUser({ emailVerified: false });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users?emailVerified=false`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.every((u: any) => u.emailVerified === false)).toBe(true);
    });

    test('pagination with limit and offset', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      for (let i = 0; i < 5; i++) {
        await createVerifiedUser();
      }

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users?limit=2&offset=0`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.length).toBe(2);
      expect(body.pagination.total).toBe(6);
      expect(body.pagination.limit).toBe(2);
      expect(body.pagination.offset).toBe(0);
      expect(body.pagination.hasMore).toBe(true);
    });

    test('includeStats returns generation counts', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();
      await createQueuedGeneration(user.id);
      await createCompletedGeneration(user.id);
      await createFailedGeneration(user.id);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users?includeStats=true`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      const targetUser = body.users.find((u: any) => u.id === user.id);
      expect(targetUser.stats).toBeDefined();
      expect(targetUser.stats.totalGenerations).toBe(3);
      expect(targetUser.stats.queuedGenerations).toBe(1);
      expect(targetUser.stats.completedGenerations).toBe(1);
      expect(targetUser.stats.failedGenerations).toBe(1);
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/users/:id', () => {
    test('returns user details for admin', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser({ username: 'targetuser' });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe(user.id);
      expect(body.user.username).toBe('targetuser');
      expect(body.stats).toBeDefined();
      expect(body.stats.totalMedia).toBeDefined();
      expect(body.stats.totalGenerations).toBeDefined();
      expect(body.stats.accountAge).toBeDefined();
    });

    test('returns 404 for non-existent user', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/00000000-0000-0000-0000-000000000000`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(404);
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();
      const { user: otherUser } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${otherUser.id}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/some-id`);
      expect(res.status).toBe(401);
    });
  });
});
