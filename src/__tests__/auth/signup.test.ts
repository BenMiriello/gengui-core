import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import bcrypt from 'bcrypt';
import {
  closeDb,
  createTestUser,
  getEmailVerificationTokensForUser,
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

describe('POST /api/auth/signup', () => {
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

  describe('Happy Path', () => {
    test('creates user with valid input and returns 201', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'newuser@example.com',
          username: 'newuser',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.email).toBe('newuser@example.com');
      expect(body.user.username).toBe('newuser');
      expect(body.user.emailVerified).toBe(false);
    });

    test('sets httpOnly session cookie', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'cookietest@example.com',
          username: 'cookietest',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(201);

      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('sessionToken=');
      expect(setCookie?.toLowerCase()).toContain('httponly');
    });

    test('hashes password in DB (not stored as plaintext)', async () => {
      const password = 'SecurePassword123!';
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'hashtest@example.com',
          username: 'hashtest',
          password,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();

      const user = await getUserFromDb(body.user.id);
      expect(user.password_hash).not.toBe(password);
      expect(user.password_hash).toMatch(/^\$2[aby]\$/);

      const isValid = await bcrypt.compare(password, user.password_hash);
      expect(isValid).toBe(true);
    });

    test('sends verification email', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'emailtest@example.com',
          username: 'emailtest',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(201);
      expect(emailMock.sendVerificationEmail).toHaveBeenCalledTimes(1);

      const call = emailMock.sendVerificationEmail.mock.calls[0];
      expect(call[0]).toBe('emailtest@example.com');
      expect(call[1]).toMatch(/^[a-f0-9]{64}$/);
    });

    test('does not return password hash in response', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nohash@example.com',
          username: 'nohash',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();

      expect(body.user.passwordHash).toBeUndefined();
      expect(body.user.password_hash).toBeUndefined();
      expect(body.user.password).toBeUndefined();
    });
  });

  describe('Validation Rejections', () => {
    test('rejects missing email', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'nomail',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects missing username', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nouser@example.com',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects missing password', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nopass@example.com',
          username: 'nopass',
        }),
      });

      expect(response.status).toBe(400);
    });

    test('rejects invalid email format', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'notanemail',
          username: 'bademail',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('rejects short username', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'short@example.com',
          username: 'ab',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('rejects username with special characters', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'special@example.com',
          username: 'user@name',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('rejects weak password', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'weak@example.com',
          username: 'weakpass',
          password: 'short',
        }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe('Duplicate Prevention', () => {
    test('rejects duplicate email', async () => {
      await createTestUser({ email: 'existing@example.com' });

      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          username: 'newuser',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('Email already in use');
    });

    test('rejects duplicate username', async () => {
      await createTestUser({ username: 'existinguser' });

      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new@example.com',
          username: 'existinguser',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('Username already taken');
    });
  });

  describe('Security', () => {
    test('rejects mass assignment of role to admin', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tryadmin@example.com',
          username: 'tryadmin',
          password: 'SecurePassword123!',
          role: 'admin',
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();

      const user = await getUserFromDb(body.user.id);
      expect(user.role).toBe('user');
      expect(user.role).not.toBe('admin');
    });

    test('rejects mass assignment of emailVerified to true', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tryverified@example.com',
          username: 'tryverified',
          password: 'SecurePassword123!',
          emailVerified: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();

      const user = await getUserFromDb(body.user.id);
      expect(user.email_verified).toBe(false);
    });

    test('creates verification token in database', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tokentest@example.com',
          username: 'tokentest',
          password: 'SecurePassword123!',
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();

      const tokens = await getEmailVerificationTokensForUser(body.user.id);
      expect(tokens.length).toBe(1);
      expect(tokens[0].token).toMatch(/^[a-f0-9]{64}$/);
      expect(tokens[0].email).toBe('tokentest@example.com');
    });
  });
});
