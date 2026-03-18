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
  createTestUser,
  createVerifiedUser,
  getEmailVerificationTokensForUser,
  getSessionsForUser,
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

describe('Email Change', () => {
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

  describe('POST /api/auth/email/initiate-change', () => {
    test('initiates email change with valid password', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
          },
          body: JSON.stringify({ email: newEmail, password }),
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('sets pendingEmail in DB', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const dbUser = await getUserFromDb(user.id);
      expect(dbUser.pending_email).toBe(newEmail);
    });

    test('sends verification email to new email address', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      expect(emailMock.sendEmailChangeVerification).toHaveBeenCalled();
      expect(emailMock.sendEmailChangeVerification).toHaveBeenCalledWith(
        newEmail,
        expect.any(String),
      );
    });

    test('rejects wrong password with 401', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
          },
          body: JSON.stringify({
            email: 'newemail@example.com',
            password: 'WrongPassword123!',
          }),
        },
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('Current password is incorrect');
    });

    test('rejects invalid email format with 409', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
          },
          body: JSON.stringify({
            email: 'not-an-email',
            password,
          }),
        },
      );

      expect(response.status).toBe(409);
    });

    test('rejects email already in use by another user', async () => {
      const { user: otherUser } = await createVerifiedUser();
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
          },
          body: JSON.stringify({
            email: otherUser.email,
            password,
          }),
        },
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('Email already in use');
    });

    test('requires authentication (returns 401 without cookie)', async () => {
      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'newemail@example.com',
            password: 'SomePassword123!',
          }),
        },
      );

      expect(response.status).toBe(401);
    });

    test('rejects missing email with 400', async () => {
      const { user, password } = await createVerifiedUser();

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
          },
          body: JSON.stringify({ password }),
        },
      );

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

      const response = await fetch(
        `${baseUrl}/api/auth/email/initiate-change`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
          },
          body: JSON.stringify({ email: 'newemail@example.com' }),
        },
      );

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/auth/email/confirm-change', () => {
    test('changes email with valid token', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const token = emailMock.getLastVerificationToken();

      const response = await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user.email).toBe(newEmail);
    });

    test('sets emailVerified to true after change', async () => {
      const { user, password } = await createTestUser({ emailVerified: false });
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const token = emailMock.getLastVerificationToken();

      await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const dbUser = await getUserFromDb(user.id);
      expect(dbUser.email_verified).toBe(true);
    });

    test('clears pendingEmail after change', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const dbUserBefore = await getUserFromDb(user.id);
      expect(dbUserBefore.pending_email).toBe(newEmail);

      const token = emailMock.getLastVerificationToken();

      await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const dbUserAfter = await getUserFromDb(user.id);
      expect(dbUserAfter.pending_email).toBeNull();
    });

    test('invalidates all sessions after email change', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const sessionsBeforeConfirm = await getSessionsForUser(user.id);
      expect(sessionsBeforeConfirm.length).toBe(1);

      const token = emailMock.getLastVerificationToken();

      await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const sessionsAfter = await getSessionsForUser(user.id);
      expect(sessionsAfter.length).toBe(0);
    });

    test('deletes all verification tokens for user after change', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const tokensBefore = await getEmailVerificationTokensForUser(user.id);
      expect(tokensBefore.length).toBe(1);

      const token = emailMock.getLastVerificationToken();

      await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const tokensAfter = await getEmailVerificationTokensForUser(user.id);
      expect(tokensAfter.length).toBe(0);
    });

    test('rejects invalid token with 401', async () => {
      const response = await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid-garbage-token' }),
      });

      expect(response.status).toBe(401);
    });

    test('rejects missing token with 400', async () => {
      const response = await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    test('can login with new email after change', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const token = emailMock.getLastVerificationToken();

      await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const newLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: newEmail, password }),
      });

      expect(newLoginResponse.status).toBe(200);
    });

    test('cannot login with old email after change', async () => {
      const { user, password } = await createVerifiedUser();
      const newEmail = 'newemail@example.com';

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });
      const cookie = loginResponse.headers.get('set-cookie') ?? '';

      await fetch(`${baseUrl}/api/auth/email/initiate-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail, password }),
      });

      const token = emailMock.getLastVerificationToken();

      await fetch(`${baseUrl}/api/auth/email/confirm-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const oldEmailLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: user.email, password }),
      });

      expect(oldEmailLoginResponse.status).toBe(401);
    });
  });
});
