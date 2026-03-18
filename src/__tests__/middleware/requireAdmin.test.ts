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
  createAdminUser,
  createVerifiedUser,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearRedisStore,
  emailMock,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Admin Middleware', () => {
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
    emailMock.reset();
    clearRedisStore();
  });

  describe('requireAdmin', () => {
    test('passes admin user through', async () => {
      const { user, password } = await createAdminUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-admin`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('returns user data for admin', async () => {
      const { user, password } = await createAdminUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-admin`, {
        headers: { Cookie: cookie },
      });

      const body = await response.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(user.id);
      expect(body.user.role).toBe('admin');
    });

    test('rejects regular user with 403', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/test/require-admin`, {
        headers: { Cookie: cookie },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain('Admin access required');
    });

    test('rejects unauthenticated request with 401', async () => {
      const response = await fetch(`${baseUrl}/test/require-admin`);

      expect(response.status).toBe(401);
    });

    test('rejects request with invalid session token with 401', async () => {
      const response = await fetch(`${baseUrl}/test/require-admin`, {
        headers: { Cookie: 'sessionToken=invalid-token' },
      });

      expect(response.status).toBe(401);
    });
  });
});
