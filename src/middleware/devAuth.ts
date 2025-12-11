import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { UnauthorizedError } from '../utils/errors';

export function devAuth(req: Request, _res: Response, next: NextFunction) {
  if (env.NODE_ENV !== 'development') {
    logger.error('Dev auth middleware used in non-development environment');
    throw new UnauthorizedError('Authentication required');
  }

  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    throw new UnauthorizedError('Missing X-User-Id header');
  }

  req.user = { id: userId };
  logger.debug({ userId }, 'Dev auth: user authenticated');
  next();
}
