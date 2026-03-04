import type { Request } from 'express';

export function requireUser(req: Request): asserts req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    throw new Error('User not authenticated');
  }
}
