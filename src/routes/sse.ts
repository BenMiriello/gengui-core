import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { authorizationService } from '../services/authorization';
import { sseService } from '../services/sse';
import { logger } from '../utils/logger';

const router = Router();

const SubscribeSchema = z.object({
  channels: z.array(z.string().min(1)).min(1).max(20),
});

/**
 * GET /sse/events
 * Unified SSE endpoint. Establishes connection and auto-subscribes to user channel.
 * Supports Last-Event-ID header for replay on reconnection.
 */
router.get('/sse/events', requireAuth, (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const userId = req.user.id;
  const clientId = `sse:${userId}:${randomUUID()}`;
  const userChannel = `user:${userId}`;

  const lastEventIdHeader = req.headers['last-event-id'];
  const lastEventId = lastEventIdHeader
    ? parseInt(String(lastEventIdHeader), 10)
    : undefined;

  logger.debug(
    { clientId, userId, lastEventId },
    'Unified SSE client connecting',
  );

  sseService.addUnifiedClient(
    clientId,
    userId,
    res,
    [userChannel],
    lastEventId,
  );
});

/**
 * POST /sse/subscribe
 * Add channels to an existing SSE client's subscription.
 * Header: X-SSE-Client-Id
 */
router.post(
  '/sse/subscribe',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const clientId = req.headers['x-sse-client-id'];
      if (!clientId || typeof clientId !== 'string') {
        res.status(400).json({
          error: {
            message: 'Missing X-SSE-Client-Id header',
            code: 'INVALID_REQUEST',
          },
        });
        return;
      }

      const bodyResult = SubscribeSchema.safeParse(req.body);
      if (!bodyResult.success) {
        res.status(400).json({
          error: {
            message:
              bodyResult.error.issues[0]?.message || 'Invalid request body',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const { channels } = bodyResult.data;
      const userId = req.user.id;

      for (const channel of channels) {
        const result = await authorizationService.validateChannelAccess(
          userId,
          channel,
        );
        if (!result.valid) {
          const status = result.code === 'INVALID_INPUT' ? 400 : 403;
          res.status(status).json({
            error: { message: result.reason, code: result.code },
          });
          return;
        }
      }

      const success = sseService.addChannels(clientId, channels);
      if (!success) {
        res.status(404).json({
          error: { message: 'SSE client not found', code: 'NOT_FOUND' },
        });
        return;
      }

      logger.debug({ clientId, channels }, 'SSE channels subscribed');
      res.json({
        success: true,
        channels: sseService.getClientChannels(clientId),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /sse/unsubscribe
 * Remove channels from an existing SSE client's subscription.
 * Header: X-SSE-Client-Id
 */
router.post(
  '/sse/unsubscribe',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const clientId = req.headers['x-sse-client-id'];
      if (!clientId || typeof clientId !== 'string') {
        res.status(400).json({
          error: {
            message: 'Missing X-SSE-Client-Id header',
            code: 'INVALID_REQUEST',
          },
        });
        return;
      }

      const bodyResult = SubscribeSchema.safeParse(req.body);
      if (!bodyResult.success) {
        res.status(400).json({
          error: {
            message:
              bodyResult.error.issues[0]?.message || 'Invalid request body',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const { channels } = bodyResult.data;
      const userId = req.user.id;

      for (const channel of channels) {
        const result = await authorizationService.validateChannelAccess(
          userId,
          channel,
        );
        if (!result.valid) {
          const status = result.code === 'INVALID_INPUT' ? 400 : 403;
          res.status(status).json({
            error: { message: result.reason, code: result.code },
          });
          return;
        }
      }

      const success = sseService.removeChannels(clientId, channels);
      if (!success) {
        res.status(404).json({
          error: { message: 'SSE client not found', code: 'NOT_FOUND' },
        });
        return;
      }

      logger.debug({ clientId, channels }, 'SSE channels unsubscribed');
      res.json({
        success: true,
        channels: sseService.getClientChannels(clientId),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /sse/status
 * Debug endpoint to check SSE service status.
 */
router.get('/sse/status', requireAuth, (_req: Request, res: Response) => {
  res.json({
    clientCount: sseService.getClientCount(),
    currentEventId: sseService.getCurrentEventId(),
  });
});

export { router as sseRouter };
