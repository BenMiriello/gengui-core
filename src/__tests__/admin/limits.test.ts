import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createAdminUser,
  createVerifiedUser,
  resetUserCounter,
  runMigrations,
  truncateAll,
} from '../helpers';
import { clearRedisStore, clearStorageData, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Admin Limits', () => {
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
    clearRedisStore();
    clearStorageData();
  });

  describe('GET /admin/users/:id/limits', () => {
    test('returns default limit of 20 if not set', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe(user.id);
      expect(body.dailyLimit).toBe(20);
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/some-id/limits`);
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /admin/users/:id/limits', () => {
    test('updates user daily limit', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dailyLimit: 50 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe(user.id);
      expect(body.dailyLimit).toBe(50);

      const getRes = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        headers: { Cookie: cookie },
      });
      const getBody = await getRes.json();
      expect(getBody.dailyLimit).toBe(50);
    });

    test('allows setting limit to 0', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dailyLimit: 0 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dailyLimit).toBe(0);
    });

    test('returns 400 for negative limit', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dailyLimit: -1 }),
      });

      expect(res.status).toBe(400);
    });

    test('returns 400 for non-number limit', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dailyLimit: 'fifty' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('number');
    });

    test('returns 400 for missing dailyLimit', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();
      const { user } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    test('returns 404 for non-existent user', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/00000000-0000-0000-0000-000000000000/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dailyLimit: 50 }),
      });

      expect(res.status).toBe(404);
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/users/${user.id}/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ dailyLimit: 50 }),
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/some-id/limits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyLimit: 50 }),
      });

      expect(res.status).toBe(401);
    });
  });
});
