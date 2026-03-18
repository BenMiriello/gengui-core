import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

import type { Express } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';

describe('Auth Rate Limiters', () => {
  let app: Express;
  let server: ReturnType<Express['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    mockLoggerWarn.mockClear();

    const authRateLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: 'Too many authentication attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        mockLoggerWarn({ ip: req.ip }, 'Auth rate limit exceeded');
        res.status(429).json({
          error: 'Too many authentication attempts, please try again later',
        });
      },
    });

    app = express();
    app.use(express.json());
    app.post('/test-auth', authRateLimiter, (_req, res) => {
      res.json({ ok: true });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  test('returns 429 after exceeding limit (5 requests)', async () => {
    const responses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${baseUrl}/test-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      responses.push(response.status);
    }

    expect(responses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(responses[5]).toBe(429);
  });

  test('returns correct rate limit headers', async () => {
    const response = await fetch(`${baseUrl}/test-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.headers.get('RateLimit-Limit')).toBe('5');
    expect(response.headers.get('RateLimit-Remaining')).toBe('4');
    expect(response.headers.get('RateLimit-Reset')).toBeDefined();
  });

  test('returns error JSON on limit exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/test-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const response = await fetch(`${baseUrl}/test-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toContain('Too many authentication attempts');
  });

  test('logs warning when rate limit exceeded', async () => {
    for (let i = 0; i < 6; i++) {
      await fetch(`${baseUrl}/test-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    }

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ ip: expect.any(String) }),
      'Auth rate limit exceeded',
    );
  });
});

describe('Signup Rate Limiter', () => {
  let app: Express;
  let server: ReturnType<Express['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    mockLoggerWarn.mockClear();

    const signupRateLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 3,
      message: 'Too many signup attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        mockLoggerWarn({ ip: req.ip }, 'Signup rate limit exceeded');
        res.status(429).json({
          error: 'Too many signup attempts, please try again later',
        });
      },
    });

    app = express();
    app.use(express.json());
    app.post('/test-signup', signupRateLimiter, (_req, res) => {
      res.json({ ok: true });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  test('returns 429 after exceeding limit (3 requests)', async () => {
    const responses: number[] = [];

    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${baseUrl}/test-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      responses.push(response.status);
    }

    expect(responses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(responses[3]).toBe(429);
  });
});

describe('Password Reset Rate Limiter', () => {
  let app: Express;
  let server: ReturnType<Express['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    mockLoggerWarn.mockClear();

    const passwordResetRateLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 3,
      message: 'Too many password reset attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        mockLoggerWarn({ ip: req.ip }, 'Password reset rate limit exceeded');
        res.status(429).json({
          error: 'Too many password reset attempts, please try again later',
        });
      },
    });

    app = express();
    app.use(express.json());
    app.post('/test-reset', passwordResetRateLimiter, (_req, res) => {
      res.json({ ok: true });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  test('returns 429 after exceeding limit (3 requests)', async () => {
    const responses: number[] = [];

    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${baseUrl}/test-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      responses.push(response.status);
    }

    expect(responses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(responses[3]).toBe(429);
  });
});

describe('Email Verification Rate Limiter', () => {
  let app: Express;
  let server: ReturnType<Express['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    mockLoggerWarn.mockClear();

    const emailVerificationRateLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      message: 'Too many email verification attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        mockLoggerWarn(
          { ip: req.ip },
          'Email verification rate limit exceeded',
        );
        res.status(429).json({
          error: 'Too many email verification attempts, please try again later',
        });
      },
    });

    app = express();
    app.use(express.json());
    app.post('/test-verify', emailVerificationRateLimiter, (_req, res) => {
      res.json({ ok: true });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  test('returns 429 after exceeding limit (5 requests)', async () => {
    const responses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${baseUrl}/test-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      responses.push(response.status);
    }

    expect(responses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(responses[5]).toBe(429);
  });
});
