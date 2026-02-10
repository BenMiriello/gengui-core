import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, resetUserCounter, truncateAll } from '../helpers';
import { clearRedisStore, emailMock, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Security Headers', () => {
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

  describe('Helmet headers', () => {
    test('sets Content-Security-Policy header', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const csp = response.headers.get('content-security-policy');

      expect(csp).toBeDefined();
      expect(csp).not.toBeNull();
    });

    test('CSP includes script-src directive', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const csp = response.headers.get('content-security-policy');

      expect(csp).toContain('script-src');
    });

    test('CSP includes default-src directive', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const csp = response.headers.get('content-security-policy');

      expect(csp).toContain('default-src');
    });

    test('sets X-Content-Type-Options: nosniff', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const xContentTypeOptions = response.headers.get('x-content-type-options');

      expect(xContentTypeOptions).toBe('nosniff');
    });

    test('sets X-Frame-Options', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const xFrameOptions = response.headers.get('x-frame-options');

      expect(xFrameOptions).toBeDefined();
      expect(['DENY', 'SAMEORIGIN']).toContain(xFrameOptions);
    });

    test('does not expose X-Powered-By header', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const xPoweredBy = response.headers.get('x-powered-by');

      expect(xPoweredBy).toBeNull();
    });

    test('sets X-DNS-Prefetch-Control', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const dnsPrefetch = response.headers.get('x-dns-prefetch-control');

      expect(dnsPrefetch).toBeDefined();
    });

    test('sets X-Download-Options', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const downloadOptions = response.headers.get('x-download-options');

      expect(downloadOptions).toBe('noopen');
    });
  });
});
