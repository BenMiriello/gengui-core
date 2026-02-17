import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createAdminUser,
  createVerifiedUser,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearRedisStore,
  clearStorageData,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Admin Queue', () => {
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

  describe('GET /admin/queue/status', () => {
    test('returns queue status for admin', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/queue/status`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.depth).toBeDefined();
      expect(typeof body.depth).toBe('number');
      expect(body.isConnected).toBeDefined();
      expect(typeof body.isConnected).toBe('boolean');
    });

    test('returns depth of 0 for empty queue', async () => {
      const { user: admin, password: adminPassword } = await createAdminUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: admin.email, password: adminPassword }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/queue/status`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.depth).toBe(0);
    });

    test('returns 403 for non-admin user', async () => {
      const { user, password } = await createVerifiedUser();

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/admin/queue/status`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(403);
    });

    test('returns 401 when not authenticated', async () => {
      const res = await fetch(`${baseUrl}/api/admin/queue/status`);
      expect(res.status).toBe(401);
    });
  });
});
