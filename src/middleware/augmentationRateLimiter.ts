import type { NextFunction, Request, Response } from 'express';
import { RATE_LIMITS } from '../config/constants';
import { redis } from '../services/redis';
import { logger } from '../utils/logger';

export async function augmentationRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Only check augmentation limit if augmentation is enabled
    const promptEnhancement = req.body.promptEnhancement;
    if (!promptEnhancement?.enabled) {
      next();
      return;
    }

    const userId = req.user?.id;
    const userRole = req.user?.role;

    // Determine limit based on role
    const dailyLimit =
      userRole === 'admin'
        ? RATE_LIMITS.augmentation.admin
        : RATE_LIMITS.augmentation.user;

    // Calculate midnight UTC today
    const now = new Date();
    const todayUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const midnightTimestamp = todayUTC.getTime();

    // Redis key for today's augmentations
    const dateStr = todayUTC.toISOString().split('T')[0]; // YYYY-MM-DD
    const key = `user:${userId}:augmentations:${dateStr}`;

    // Clean up old entries (before today)
    await redis.zremrangebyscore(key, 0, midnightTimestamp - 1);

    // Count current augmentations
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
        'Augmentation rate limit exceeded',
      );

      res.status(429).json({
        error: {
          message: `Daily prompt augmentation limit exceeded. You have used ${currentCount}/${dailyLimit} augmentations today. Try again tomorrow or disable augmentation. Limit resets at midnight UTC.`,
          code: 'AUGMENTATION_RATE_LIMIT_EXCEEDED',
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
      'Augmentation rate limit check passed',
    );

    next();
  } catch (error) {
    logger.error({ error }, 'Error in augmentation rate limiter');
    // Fail open: allow augmentation on rate limiter error
    next();
  }
}
