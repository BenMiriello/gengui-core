import type { NextFunction, Request, Response } from 'express';
import { ADMIN_DAILY_LIMIT, USER_DAILY_LIMIT } from '../config/constants';
import { redis } from '../services/redis';
import { logger } from '../utils/logger';

export async function generationRateLimiter(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;

    // Determine limit based on role
    const dailyLimit = userRole === 'admin' ? ADMIN_DAILY_LIMIT : USER_DAILY_LIMIT;

    // Calculate midnight UTC today
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const midnightTimestamp = todayUTC.getTime();

    // Redis key for today's generations
    const dateStr = todayUTC.toISOString().split('T')[0]; // YYYY-MM-DD
    const key = `user:${userId}:generations:${dateStr}`;

    // Clean up old entries (before today)
    await redis.zremrangebyscore(key, 0, midnightTimestamp - 1);

    // Count current generations
    const currentCount = await redis.zcard(key);

    if (currentCount >= dailyLimit) {
      logger.warn(
        {
          userId,
          userRole,
          currentCount,
          dailyLimit,
          date: dateStr,
        },
        'Generation rate limit exceeded'
      );

      res.status(429).json({
        error: {
          message: `Daily generation limit exceeded. You have used ${currentCount}/${dailyLimit} generations today. Limit resets at midnight UTC.`,
          code: 'RATE_LIMIT_EXCEEDED',
          limit: dailyLimit,
          used: currentCount,
          resetAt: new Date(midnightTimestamp + 86400000).toISOString(), // next midnight
        },
      });
      return;
    }

    logger.debug(
      {
        userId,
        userRole,
        currentCount,
        dailyLimit,
        remaining: dailyLimit - currentCount,
      },
      'Rate limit check passed'
    );

    next();
  } catch (error) {
    logger.error({ error }, 'Error in generation rate limiter');
    // Fail open: allow generation on rate limiter error
    next();
  }
}
