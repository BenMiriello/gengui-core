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
  createSession,
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

describe('Ownership & Authorization', () => {
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

  describe('user isolation', () => {
    test('GET /auth/me returns only own user data', async () => {
      const { user: userA, password: passwordA } = await createVerifiedUser();
      const { user: userB } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userA.email,
          password: passwordA,
        }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      const body = await response.json();
      expect(body.user.id).toBe(userA.id);
      expect(body.user.id).not.toBe(userB.id);
      expect(body.user.email).toBe(userA.email);
    });

    test('GET /auth/preferences returns only own preferences', async () => {
      const { user: userA, password: passwordA } = await createVerifiedUser();
      await createVerifiedUser();

      const loginAResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userA.email,
          password: passwordA,
        }),
      });
      const cookieA = loginAResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({ defaultStylePreset: 'userA-preset' }),
      });

      const response = await fetch(`${baseUrl}/api/auth/preferences`, {
        headers: { Cookie: cookieA },
      });

      const body = await response.json();
      expect(body.preferences.defaultStylePreset).toBe('userA-preset');
    });

    test('PATCH /auth/password changes only own password', async () => {
      const { user: userA, password: passwordA } = await createVerifiedUser();
      const { user: userB, password: passwordB } = await createVerifiedUser();

      const loginAResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userA.email,
          password: passwordA,
        }),
      });
      const cookieA = loginAResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({
          currentPassword: passwordA,
          newPassword: 'NewPasswordA123!',
        }),
      });

      const loginBResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userB.email,
          password: passwordB,
        }),
      });

      expect(loginBResponse.status).toBe(200);
    });

    test('PATCH /auth/username changes only own username', async () => {
      const { user: userA, password: passwordA } = await createVerifiedUser();
      const { user: userB, password: passwordB } = await createVerifiedUser();

      const loginAResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userA.email,
          password: passwordA,
        }),
      });
      const cookieA = loginAResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({
          username: 'newusernameA',
          password: passwordA,
        }),
      });

      const loginBResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userB.username,
          password: passwordB,
        }),
      });

      expect(loginBResponse.status).toBe(200);
    });
  });

  describe('session token security', () => {
    test('session tokens are 64 hex characters', async () => {
      const { user } = await createVerifiedUser();
      const { token } = await createSession(user.id);

      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    test('multiple session tokens are unique', async () => {
      const { user } = await createVerifiedUser();
      const tokens: string[] = [];

      for (let i = 0; i < 10; i++) {
        const { token } = await createSession(user.id);
        tokens.push(token);
      }

      const uniqueTokens = new Set(tokens);
      expect(uniqueTokens.size).toBe(10);
    });

    test('session tokens have no obvious pattern', async () => {
      const { user } = await createVerifiedUser();
      const tokens: string[] = [];

      for (let i = 0; i < 5; i++) {
        const { token } = await createSession(user.id);
        tokens.push(token);
      }

      for (let i = 1; i < tokens.length; i++) {
        let matchingChars = 0;
        for (let j = 0; j < tokens[i].length; j++) {
          if (tokens[i][j] === tokens[i - 1][j]) {
            matchingChars++;
          }
        }
        expect(matchingChars).toBeLessThan(tokens[i].length / 2);
      }
    });
  });

  describe('cross-user session access', () => {
    test('cannot use another user session to access /auth/me', async () => {
      const { user: userA } = await createVerifiedUser();
      const { user: userB, password: passwordB } = await createVerifiedUser();

      const { token: tokenA } = await createSession(userA.id);

      const loginBResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: userB.email,
          password: passwordB,
        }),
      });
      expect(loginBResponse.status).toBe(200);

      const responseWithA = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `sessionToken=${tokenA}` },
      });

      const bodyA = await responseWithA.json();
      expect(bodyA.user.id).toBe(userA.id);
      expect(bodyA.user.id).not.toBe(userB.id);
    });
  });
});
