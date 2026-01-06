import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { authService } from '../services/auth';
import { UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies.sessionToken;

    if (!token) {
      throw new UnauthorizedError('Authentication required');
    }

    const user = await authService.validateSession(token);

    if (!user) {
      throw new UnauthorizedError('Invalid or expired session');
    }

    const userAgent = req.headers['user-agent'] || '';
    const sessionId = createHash('sha256')
      .update(`${token}:${userAgent}`)
      .digest('hex')
      .slice(0, 20);

    req.user = user;
    req.sessionId = sessionId;
    logger.debug({ userId: user.id, sessionId }, 'User authenticated');
    next();
  } catch (error) {
    next(error);
  }
}

export { requireAdmin } from './requireAdmin';
