process.env.NODE_ENV = 'development';
process.env.PORT = '0';
process.env.DB_NAME = 'gengui_test';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_USER = 'gengui';
process.env.DB_PASSWORD = 'gengui_dev_pass';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.GEMINI_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.FALKORDB_URL = process.env.FALKORDB_URL || 'redis://localhost:6381';
process.env.FALKORDB_GRAPH_NAME = 'gengui_test';

// Check if FalkorDB is available - if so, use real graph instead of mock
import Redis from 'ioredis';

try {
  const testClient = new Redis(process.env.FALKORDB_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
  });
  await testClient.connect();
  await testClient.quit();
  process.env.FALKORDB_AVAILABLE = 'true';
} catch {
  process.env.FALKORDB_AVAILABLE = 'false';
}

import { mock } from 'bun:test';

const noOpRateLimiter = (_req: unknown, _res: unknown, next: () => void) => next();

mock.module('../../../src/middleware/rateLimiter', () => ({
  authRateLimiter: noOpRateLimiter,
  signupRateLimiter: noOpRateLimiter,
  passwordResetRateLimiter: noOpRateLimiter,
  emailVerificationRateLimiter: noOpRateLimiter,
}));

// Ensure database schema is up-to-date ONCE before any tests run.
// Test files should only call truncateAll(), never runMigrations().
import { ensureSchema } from './setup';

await ensureSchema();
