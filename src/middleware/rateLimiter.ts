import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import { logger } from '../utils/logger';

const redisUrl = process.env.REDIS_URL;
let redisClient: Redis | undefined;

if (redisUrl) {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redisClient.on('connect', () => {
    logger.info('Rate limiter Redis client connected');
  });

  redisClient.on('error', (error) => {
    logger.error({ error }, 'Rate limiter Redis client error');
  });
}

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 5,
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient
    ? new RedisStore({
        sendCommand: async (...args: any[]) => {
          const [command, ...commandArgs] = args;
          return (await redisClient!.call(command, ...commandArgs)) as any;
        },
        prefix: 'rl:auth:',
      })
    : undefined,
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Auth rate limit exceeded');
    res.status(429).json({
      error: 'Too many authentication attempts, please try again later',
    });
  },
});

export const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 3,
  message: 'Too many signup attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient
    ? new RedisStore({
        sendCommand: async (...args: any[]) => {
          const [command, ...commandArgs] = args;
          return (await redisClient!.call(command, ...commandArgs)) as any;
        },
        prefix: 'rl:signup:',
      })
    : undefined,
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Signup rate limit exceeded');
    res.status(429).json({
      error: 'Too many signup attempts, please try again later',
    });
  },
});

export const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 3,
  message: 'Too many password reset attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient
    ? new RedisStore({
        sendCommand: async (...args: any[]) => {
          const [command, ...commandArgs] = args;
          return (await redisClient!.call(command, ...commandArgs)) as any;
        },
        prefix: 'rl:password-reset:',
      })
    : undefined,
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Password reset rate limit exceeded');
    res.status(429).json({
      error: 'Too many password reset attempts, please try again later',
    });
  },
});

export const emailVerificationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 5,
  message: 'Too many email verification attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient
    ? new RedisStore({
        sendCommand: async (...args: any[]) => {
          const [command, ...commandArgs] = args;
          return (await redisClient!.call(command, ...commandArgs)) as any;
        },
        prefix: 'rl:email-verify:',
      })
    : undefined,
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Email verification rate limit exceeded');
    res.status(429).json({
      error: 'Too many email verification attempts, please try again later',
    });
  },
});
