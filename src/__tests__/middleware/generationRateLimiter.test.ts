import type { NextFunction, Request, Response } from 'express';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from 'vitest';

const { mockZcard, mockZremrangebyscore, mockLoggerWarn, mockLoggerError } =
  vi.hoisted(() => ({
    mockZcard: vi.fn().mockResolvedValue(0),
    mockZremrangebyscore: vi.fn().mockResolvedValue(0),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }));

vi.mock('../../services/redis', () => ({
  redis: {
    zcard: mockZcard,
    zremrangebyscore: mockZremrangebyscore,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

import { generationRateLimiter } from '../../middleware/generationRateLimiter';

describe('generationRateLimiter', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: Mock;
  let jsonMock: Mock;
  let statusMock: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T15:00:00Z'));

    mockReq = {
      user: { id: 'test-user-id', role: 'user' } as Request['user'],
    };

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockRes = {
      status: statusMock,
    };

    mockNext = vi.fn();

    mockZcard.mockResolvedValue(0);
    mockZremrangebyscore.mockResolvedValue(0);
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test('allows request under limit', async () => {
    mockZcard.mockResolvedValue(5);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  test('blocks request at limit with 429', async () => {
    mockZcard.mockResolvedValue(20);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockNext).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(429);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        message: expect.stringContaining('Daily generation limit exceeded'),
        code: 'RATE_LIMIT_EXCEEDED',
        limit: 20,
        used: 20,
        resetAt: '2026-03-18T00:00:00.000Z',
      },
    });
  });

  test('blocks request over limit', async () => {
    mockZcard.mockResolvedValue(25);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockNext).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(429);
  });

  test('admin gets higher limit (200)', async () => {
    mockReq.user = { id: 'admin-user-id', role: 'admin' } as Request['user'];
    mockZcard.mockResolvedValue(100);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  test('admin blocked at 200 limit', async () => {
    mockReq.user = { id: 'admin-user-id', role: 'admin' } as Request['user'];
    mockZcard.mockResolvedValue(200);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockNext).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(429);
    expect(jsonMock).toHaveBeenCalledWith({
      error: expect.objectContaining({
        limit: 200,
        used: 200,
      }),
    });
  });

  test('includes correct resetAt timestamp (midnight UTC tomorrow)', async () => {
    mockZcard.mockResolvedValue(20);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(jsonMock).toHaveBeenCalledWith({
      error: expect.objectContaining({
        resetAt: '2026-03-18T00:00:00.000Z',
      }),
    });
  });

  test('fails open on Redis error', async () => {
    mockZcard.mockRejectedValue(new Error('Redis connection failed'));

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'Error in generation rate limiter',
    );
  });

  test('cleans up old entries before checking count', async () => {
    mockZcard.mockResolvedValue(5);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockZremrangebyscore).toHaveBeenCalledWith(
      expect.stringContaining('user:test-user-id:generations:2026-03-17'),
      0,
      expect.any(Number),
    );
  });

  test('logs warning when rate limit exceeded', async () => {
    mockZcard.mockResolvedValue(20);

    await generationRateLimiter(
      mockReq as Request,
      mockRes as Response,
      mockNext as NextFunction,
    );

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        userRole: 'user',
        currentCount: 20,
        dailyLimit: 20,
      }),
      'Generation rate limit exceeded',
    );
  });
});
