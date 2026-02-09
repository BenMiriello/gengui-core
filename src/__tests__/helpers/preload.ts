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

import { mock } from 'bun:test';

const noOpRateLimiter = (_req: unknown, _res: unknown, next: () => void) => next();

mock.module('../../../src/middleware/rateLimiter', () => ({
  authRateLimiter: noOpRateLimiter,
  signupRateLimiter: noOpRateLimiter,
  passwordResetRateLimiter: noOpRateLimiter,
  emailVerificationRateLimiter: noOpRateLimiter,
}));
