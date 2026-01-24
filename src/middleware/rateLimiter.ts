import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../services/redis';
import { logger } from '../utils/logger';

const redisClient = redis.getClient();

const createStore = (prefix: string) =>
  new RedisStore({
    sendCommand: async (...args: any[]) => {
      const [command, ...commandArgs] = args;
      return (await redisClient.call(command, ...commandArgs)) as any;
    },
    prefix,
  });

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 5,
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore('rl:auth:'),
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
  store: createStore('rl:signup:'),
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
  store: createStore('rl:password-reset:'),
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
  store: createStore('rl:email-verify:'),
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Email verification rate limit exceeded');
    res.status(429).json({
      error: 'Too many email verification attempts, please try again later',
    });
  },
});
