import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  closeDb,
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

describe('Admin RBAC', () => {
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

  describe('All admin endpoints require admin role', () => {
    const adminEndpoints = [
      { method: 'GET', path: '/api/admin/users' },
      {
        method: 'GET',
        path: '/api/admin/users/00000000-0000-0000-0000-000000000000',
      },
      {
        method: 'GET',
        path: '/api/admin/users/00000000-0000-0000-0000-000000000000/limits',
      },
      {
        method: 'PATCH',
        path: '/api/admin/users/00000000-0000-0000-0000-000000000000/limits',
      },
      { method: 'GET', path: '/api/admin/queue/status' },
      { method: 'GET', path: '/api/admin/workers/status' },
      { method: 'POST', path: '/api/admin/workers/start' },
      { method: 'POST', path: '/api/admin/workers/stop' },
    ];

    for (const endpoint of adminEndpoints) {
      test(`${endpoint.method} ${endpoint.path} returns 403 for non-admin`, async () => {
        const { user, password } = await createVerifiedUser();

        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailOrUsername: user.email, password }),
        });
        const cookie = loginRes.headers.get('set-cookie')!;

        const fetchOptions: RequestInit = {
          method: endpoint.method,
          headers: { Cookie: cookie },
        };

        if (endpoint.method === 'PATCH') {
          fetchOptions.headers = {
            ...fetchOptions.headers,
            'Content-Type': 'application/json',
          };
          fetchOptions.body = JSON.stringify({ dailyLimit: 50 });
        }

        const res = await fetch(`${baseUrl}${endpoint.path}`, fetchOptions);
        expect(res.status).toBe(403);
      });

      test(`${endpoint.method} ${endpoint.path} returns 401 when unauthenticated`, async () => {
        const fetchOptions: RequestInit = {
          method: endpoint.method,
        };

        if (endpoint.method === 'PATCH') {
          fetchOptions.headers = { 'Content-Type': 'application/json' };
          fetchOptions.body = JSON.stringify({ dailyLimit: 50 });
        }

        const res = await fetch(`${baseUrl}${endpoint.path}`, fetchOptions);
        expect(res.status).toBe(401);
      });
    }
  });
});
