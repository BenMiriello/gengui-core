import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/auth';
import { UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
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

export function requireEmailVerified(customMessage?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;

    if (!user?.emailVerified) {
      res.status(403).json({
        error: {
          message: customMessage || 'Email verification required',
          code: 'EMAIL_NOT_VERIFIED',
          details: { action: 'verify_email', email: user?.email },
        },
      });
      return;
    }
    next();
  };
}

export { requireAdmin } from './requireAdmin';
