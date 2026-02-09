import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';

export function devAuth(req: Request, _res: Response, next: NextFunction) {
  if (env.NODE_ENV !== 'development') {
    logger.error('Dev auth middleware used in non-development environment');
    throw new UnauthorizedError('Authentication required');
  }

  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    throw new UnauthorizedError('Missing X-User-Id header');
  }

  req.user = { id: userId, role: 'user' };
  logger.debug({ userId }, 'Dev auth: user authenticated');
  next();
}
