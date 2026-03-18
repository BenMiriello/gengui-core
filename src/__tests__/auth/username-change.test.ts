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
  getUserFromDb,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearRedisStore,
  emailMock,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Username Change', () => {
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

  describe('PATCH /api/auth/username', () => {
    test('updates username with valid password', async () => {
      const { user, password } = await createVerifiedUser();
      const newUsername = 'mynewusername';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: newUsername, password }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user.username).toBe(newUsername);
    });

    test('updates username in DB', async () => {
      const { user, password } = await createVerifiedUser();
      const newUsername = 'mynewusername';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: newUsername, password }),
      });

      const dbUser = await getUserFromDb(user.id);
      expect(dbUser.username).toBe(newUsername);
    });

    test('can login with new username after change', async () => {
      const { user, password } = await createVerifiedUser();
      const newUsername = 'mynewusername';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: newUsername, password }),
      });

      const newLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: newUsername, password }),
      });

      expect(newLoginResponse.status).toBe(200);
    });

    test('rejects wrong password with 401', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          username: 'newusername',
          password: 'WrongPassword123!',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('Current password is incorrect');
    });

    test('rejects invalid username (too short) with 409', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: 'ab', password }),
      });

      expect(response.status).toBe(409);
    });

    test('rejects invalid username (special characters) with 409', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: 'user@name', password }),
      });

      expect(response.status).toBe(409);
    });

    test('rejects duplicate username (taken by another user) with 409', async () => {
      const { user: otherUser } = await createVerifiedUser();
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: otherUser.username, password }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('Username already taken');
    });

    test('allows keeping same username (no-op)', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: user.username, password }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user.username).toBe(user.username);
    });

    test('requires authentication (returns 401 without cookie)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'newusername',
          password: 'SomePassword123!',
        }),
      });

      expect(response.status).toBe(401);
    });

    test('rejects missing username with 400', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ password }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects missing password with 400', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ username: 'newusername' }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects empty body with 400', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });
});
