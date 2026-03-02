/**
 * HTTP request/response logging middleware.
 *
 * Adds requestId to all requests and logs HTTP events.
 * RequestId propagates to child loggers throughout the request lifecycle.
 */

import type { NextFunction, Request, Response } from 'express';
import { generateRequestId, logger } from '../utils/logger';

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = generateRequestId();
  req.id = requestId;
  req.log = logger.child({ requestId });

  req.log.info({
    event: 'http_request',
    method: req.method,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    userAgent: req.get('user-agent'),
    userId: (req as any).user?.id,
    ip: req.ip,
  });

  const startTime = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const level =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log?.[level]({
      event: 'http_response',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      contentLength: res.get('content-length'),
    });
  });

  res.on('error', (error: Error) => {
    req.log?.error(
      {
        event: 'http_error',
        method: req.method,
        path: req.path,
        error: error.message,
        durationMs: Date.now() - startTime,
      },
      'HTTP request failed',
    );
  });

  next();
}
