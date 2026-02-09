import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface ErrorResponse {
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const response: ErrorResponse = {
      error: {
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: err.issues,
      },
    };
    logger.warn({ err, path: req.path }, 'Validation error');
    return res.status(400).json(response);
  }

  if (err instanceof AppError) {
    const response: ErrorResponse = {
      error: {
        message: err.message,
        code: err.code,
      },
    };
    logger.warn({ err, path: req.path }, `AppError: ${err.message}`);
    return res.status(err.statusCode).json(response);
  }

  const response: ErrorResponse = {
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
  };
  logger.error({ err, path: req.path }, 'Unhandled error');
  return res.status(500).json(response);
}
