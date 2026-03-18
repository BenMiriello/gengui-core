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

import { augmentationRateLimiter } from '../../middleware/augmentationRateLimiter';

describe('augmentationRateLimiter', () => {
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
      body: { promptEnhancement: { enabled: true } },
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

  describe('when augmentation is disabled', () => {
    test('skips rate limiting when promptEnhancement is not in body', async () => {
      mockReq.body = {};

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockZcard).not.toHaveBeenCalled();
    });

    test('skips rate limiting when promptEnhancement.enabled is false', async () => {
      mockReq.body = { promptEnhancement: { enabled: false } };

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockZcard).not.toHaveBeenCalled();
    });
  });

  describe('when augmentation is enabled', () => {
    test('allows request under limit', async () => {
      mockZcard.mockResolvedValue(5);

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    test('blocks request at limit with 429', async () => {
      mockZcard.mockResolvedValue(20);

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(429);
      expect(jsonMock).toHaveBeenCalledWith({
        error: {
          message: expect.stringContaining(
            'Daily prompt augmentation limit exceeded',
          ),
          code: 'AUGMENTATION_RATE_LIMIT_EXCEEDED',
          limit: 20,
          used: 20,
          resetAt: '2026-03-18T00:00:00.000Z',
        },
      });
    });

    test('blocks request over limit', async () => {
      mockZcard.mockResolvedValue(25);

      await augmentationRateLimiter(
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

      await augmentationRateLimiter(
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

      await augmentationRateLimiter(
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

    test('uses augmentations key (not generations)', async () => {
      mockZcard.mockResolvedValue(0);

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockZcard).toHaveBeenCalledWith(
        'user:test-user-id:augmentations:2026-03-17',
      );
    });
  });

  describe('authentication', () => {
    test('returns 401 when req.user is missing', async () => {
      mockReq.user = undefined;

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        error: { message: 'Authentication required', code: 'UNAUTHORIZED' },
      });
      expect(mockZcard).not.toHaveBeenCalled();
    });

    test('returns 401 when req.user.id is missing', async () => {
      mockReq.user = { role: 'user' } as Request['user'];

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  describe('error handling', () => {
    test('fails open on Redis error', async () => {
      mockZcard.mockRejectedValue(new Error('Redis connection failed'));

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Error in augmentation rate limiter',
      );
    });

    test('fails open when zremrangebyscore fails', async () => {
      mockZremrangebyscore.mockRejectedValue(new Error('TIMEOUT'));
      mockZcard.mockResolvedValue(0);

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('day boundary handling', () => {
    test('uses correct date key at 23:59 UTC', async () => {
      vi.setSystemTime(new Date('2026-03-17T23:59:59.999Z'));
      mockZcard.mockResolvedValue(0);

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockZcard).toHaveBeenCalledWith(
        'user:test-user-id:augmentations:2026-03-17',
      );
    });

    test('uses new date key at 00:01 UTC', async () => {
      vi.setSystemTime(new Date('2026-03-18T00:01:00.000Z'));
      mockZcard.mockResolvedValue(0);

      await augmentationRateLimiter(
        mockReq as Request,
        mockRes as Response,
        mockNext as NextFunction,
      );

      expect(mockZcard).toHaveBeenCalledWith(
        'user:test-user-id:augmentations:2026-03-18',
      );
    });
  });

  test('logs warning when rate limit exceeded', async () => {
    mockZcard.mockResolvedValue(20);

    await augmentationRateLimiter(
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
      'Augmentation rate limit exceeded',
    );
  });
});
