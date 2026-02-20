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
  getSessionsForUser,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import {
  clearRedisStore,
  emailMock,
  startTestServer,
  stopTestServer,
} from '../helpers/testApp';

describe('Password Change', () => {
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

  describe('PATCH /api/auth/password', () => {
    test('changes password with correct current password', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('new password works for login after change', async () => {
      const { user, password } = await createVerifiedUser();
      const newPassword = 'NewSecurePassword123!';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword,
        }),
      });

      const newLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: user.email,
          password: newPassword,
        }),
      });

      expect(newLoginResponse.status).toBe(200);
    });

    test('old password no longer works after change', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'NewSecurePassword123!',
        }),
      });

      const oldPasswordLoginResponse = await fetch(
        `${baseUrl}/api/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailOrUsername: user.email, password }),
        },
      );

      expect(oldPasswordLoginResponse.status).toBe(401);
    });

    test('rejects wrong current password with 401', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: 'WrongPassword123!',
          newPassword: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('Current password is incorrect');
    });

    test('rejects same password with 409', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: password,
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('must be different');
    });

    test('validates new password strength (rejects weak password)', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'weak',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('invalidates all sessions after password change', async () => {
      const { user, password } = await createVerifiedUser();

      await createSession(user.id);
      await createSession(user.id);

      const sessionsBefore = await getSessionsForUser(user.id);
      expect(sessionsBefore.length).toBe(2);

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const sessionsAfterLogin = await getSessionsForUser(user.id);
      expect(sessionsAfterLogin.length).toBe(3);

      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'NewSecurePassword123!',
        }),
      });

      const sessionsAfter = await getSessionsForUser(user.id);
      expect(sessionsAfter.length).toBe(0);
    });

    test('old session cookie returns 401 after password change', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'NewSecurePassword123!',
        }),
      });

      const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });

      expect(meResponse.status).toBe(401);
    });

    test('sends password-changed email after successful change', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'NewSecurePassword123!',
        }),
      });

      expect(emailMock.sendPasswordChangedEmail).toHaveBeenCalled();
      expect(emailMock.sendPasswordChangedEmail).toHaveBeenCalledWith(
        user.email,
      );
    });

    test('requires authentication (returns 401 without cookie)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: 'SomePassword123!',
          newPassword: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(401);
    });

    test('rejects missing currentPassword with 400', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          newPassword: 'NewSecurePassword123!',
        }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects missing newPassword with 400', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          currentPassword: password,
        }),
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

      const response = await fetch(`${baseUrl}/api/auth/password`, {
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
