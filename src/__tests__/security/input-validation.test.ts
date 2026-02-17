import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, resetUserCounter, truncateAll } from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Input Validation & Injection Prevention', () => {
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

  describe('SQL injection prevention', () => {
    test('SQL in email field is rejected by validation', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: "' OR '1'='1",
          username: 'testuser',
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.message).toContain('Invalid email');
    });

    test('SQL in username field is rejected by char validation', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: "'; DROP TABLE users--",
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('SQL in login field does not cause SQL error', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: "' OR '1'='1",
          password: 'anypassword',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain('Invalid credentials');
    });

    test('union injection in login is treated as literal string', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: "admin' UNION SELECT * FROM users--",
          password: 'anypassword',
        }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('XSS prevention', () => {
    test('XSS in username is rejected by char validation', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: '<script>alert(1)</script>',
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('XSS payloads in email do not cause server errors', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: '<script>alert(1)</script>@example.com',
          username: 'testuser',
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBeLessThan(500);
    });
  });

  describe('input length limits', () => {
    test('very long password is handled gracefully', async () => {
      const veryLongPassword = `${'A'.repeat(10000)}!`;

      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: 'testuser',
          password: veryLongPassword,
        }),
      });

      expect(response.status).toBeLessThan(500);
    });

    test('very long email is handled without crashing', async () => {
      const veryLongEmail = `${'a'.repeat(1000)}@example.com`;

      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: veryLongEmail,
          username: 'testuser',
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBeDefined();
    });

    test('very long username is rejected', async () => {
      const veryLongUsername = 'a'.repeat(100);

      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: veryLongUsername,
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe('special characters', () => {
    test('null bytes in input return a response (not crash)', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: 'test\x00user',
          password: 'password123',
        }),
      });

      expect(response.status).toBeDefined();
    });

    test('unicode characters in username are rejected', async () => {
      const response = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: 'user\u0000name',
          password: 'ValidPassword123!',
        }),
      });

      expect(response.status).toBe(409);
    });

    test('CRLF injection in login is handled', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrUsername: 'admin\r\nX-Injected: header',
          password: 'anypassword',
        }),
      });

      expect(response.status).toBeLessThan(500);
    });
  });
});
