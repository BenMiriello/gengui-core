import { Request, Response, NextFunction } from 'express';
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

    req.user = user;
    logger.debug({ userId: user.id }, 'User authenticated');
    next();
  } catch (error) {
    next(error);
  }
}
