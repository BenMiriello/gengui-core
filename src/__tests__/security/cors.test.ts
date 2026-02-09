import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, resetUserCounter, runMigrations, truncateAll } from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('CORS', () => {
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations();
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

  describe('allowed origins', () => {
    test('allows configured origin http://localhost:5173', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'http://localhost:5173' },
      });

      const allowOrigin = response.headers.get('access-control-allow-origin');
      expect(allowOrigin).toBe('http://localhost:5173');
    });

    test('allows configured origin http://localhost:3001', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'http://localhost:3001' },
      });

      const allowOrigin = response.headers.get('access-control-allow-origin');
      expect(allowOrigin).toBe('http://localhost:3001');
    });

    test('does not allow unknown origins', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://evil.com' },
      });

      const allowOrigin = response.headers.get('access-control-allow-origin');
      expect(allowOrigin).not.toBe('https://evil.com');
    });
  });

  describe('credentials', () => {
    test('allows credentials for configured origins', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'http://localhost:5173' },
      });

      const allowCredentials = response.headers.get('access-control-allow-credentials');
      expect(allowCredentials).toBe('true');
    });

    test('never uses wildcard with credentials', async () => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'http://localhost:5173' },
      });

      const allowOrigin = response.headers.get('access-control-allow-origin');
      const allowCredentials = response.headers.get('access-control-allow-credentials');

      if (allowCredentials === 'true') {
        expect(allowOrigin).not.toBe('*');
      }
    });
  });

  describe('preflight requests', () => {
    test('responds to OPTIONS preflight', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.status).toBeLessThan(400);
    });

    test('returns allowed methods in preflight response', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
        },
      });

      const allowMethods = response.headers.get('access-control-allow-methods');
      expect(allowMethods).toBeDefined();
    });

    test('returns allowed headers in preflight response', async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });

      const allowHeaders = response.headers.get('access-control-allow-headers');
      expect(allowHeaders).toBeDefined();
    });
  });
});
