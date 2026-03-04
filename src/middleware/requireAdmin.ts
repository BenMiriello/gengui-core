import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';
import { requireAuth } from './auth';

/**
 * Middleware to require admin role for route access.
 * Logs all admin access attempts for audit purposes.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // First ensure user is authenticated
    await requireAuth(req, res, (err) => {
      if (err) {
        return next(err);
      }

      if (!req.user) {
        logger.error(
          { path: req.path },
          'Admin check: no user after authentication',
        );
        return next(new UnauthorizedError('Authentication required'));
      }

      const user = req.user;
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';

      // Check admin role
      if (user.role !== 'admin') {
        logger.warn(
          {
            userId: user.id,
            userRole: user.role,
            ip,
            userAgent,
            endpoint: req.path,
            method: req.method,
            sessionId: req.sessionId,
            accessGranted: false,
          },
          'Admin access denied - insufficient privileges',
        );
        throw new ForbiddenError('Admin access required');
      }

      // Success - log admin access (debug level for polling endpoints)
      const isPollingEndpoint =
        req.path.includes('/usage') || req.path.includes('/queue');
      const logLevel = isPollingEndpoint ? 'debug' : 'info';

      logger[logLevel](
        {
          userId: user.id,
          userRole: user.role,
          ip,
          userAgent,
          endpoint: req.path,
          method: req.method,
          sessionId: req.sessionId,
          accessGranted: true,
        },
        'Admin access granted',
      );

      next();
    });
  } catch (error) {
    next(error);
  }
}
