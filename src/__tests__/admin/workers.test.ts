import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createAdminUser,
  createVerifiedUser,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, clearStorageData, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Admin Workers', () => {
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
    clearRedisStore();
    clearStorageData();
  });

  describe('GET /admin/workers/status', () => {
    test('returns not_implemented status for admin', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/workers/status`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('not_implemented');
      expect(body.message).toContain('#198');
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/workers/status`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/workers/status`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /admin/workers/start', () => {
    test('returns 400 for not implemented', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/workers/start`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('not yet implemented');
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/workers/start`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/workers/start`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /admin/workers/stop', () => {
    test('returns 400 for not implemented', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/workers/stop`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('not yet implemented');
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/workers/stop`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/workers/stop`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });
});
