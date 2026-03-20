import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { activityService } from '../services/activity.service';

const router = Router();

const ListQuerySchema = z.object({
  status: z
    .enum(['pending', 'running', 'completed', 'failed', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const MarkViewedSchema = z.object({
  activityIds: z.array(z.string().uuid()).min(1).max(100),
});

/**
 * GET /api/activities
 * List activities with pagination and optional status filter
 */
router.get(
  '/activities',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');

      const queryResult = ListQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        res.status(400).json({
          error: {
            message: queryResult.error.issues[0]?.message || 'Invalid query',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const { status, limit, offset } = queryResult.data;
      const activities = await activityService.list(req.user.id, {
        status,
        limit,
        offset,
      });

      res.json({ activities });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/activities/recent
 * Get active activities + last 10 completed (for SSE reconnect)
 */
router.get(
  '/activities/recent',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');

      const activities = await activityService.getRecent(req.user.id);
      res.json({ activities });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/activities/mark-viewed
 * Bulk mark activities as viewed
 */
router.post(
  '/activities/mark-viewed',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');

      const bodyResult = MarkViewedSchema.safeParse(req.body);
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

      await activityService.markViewed(bodyResult.data.activityIds);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/activities/:id/retry
 * Retry a failed activity
 */
router.post(
  '/activities/:id/retry',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');

      const { id } = req.params;
      const activity = await activityService.retry(id, req.user.id);

      if (!activity) {
        res.status(404).json({
          error: { message: 'Activity not found', code: 'NOT_FOUND' },
        });
        return;
      }

      res.json({ activity });
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message === 'Unauthorized' ||
          error.message === 'Activity not found'
        ) {
          res.status(404).json({
            error: { message: 'Activity not found', code: 'NOT_FOUND' },
          });
          return;
        }
        if (error.message.includes('Can only retry')) {
          res.status(400).json({
            error: { message: error.message, code: 'INVALID_STATE' },
          });
          return;
        }
      }
      next(error);
    }
  },
);

/**
 * POST /api/activities/:id/cancel
 * Cancel a pending/running activity
 */
router.post(
  '/activities/:id/cancel',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');

      const { id } = req.params;
      const activity = await activityService.cancel(id, req.user.id);

      if (!activity) {
        res.status(404).json({
          error: { message: 'Activity not found', code: 'NOT_FOUND' },
        });
        return;
      }

      res.json({ activity });
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message === 'Unauthorized' ||
          error.message === 'Activity not found'
        ) {
          res.status(404).json({
            error: { message: 'Activity not found', code: 'NOT_FOUND' },
          });
          return;
        }
        if (error.message.includes('Can only cancel')) {
          res.status(400).json({
            error: { message: error.message, code: 'INVALID_STATE' },
          });
          return;
        }
      }
      next(error);
    }
  },
);

/**
 * POST /api/activities/sync-orphaned
 * Sync orphaned activities with their job status (admin use)
 */
router.post(
  '/activities/sync-orphaned',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');

      const syncedCount = await activityService.syncOrphanedActivities();
      res.json({ synced: syncedCount });
    } catch (error) {
      next(error);
    }
  },
);

// SSE endpoint removed - use unified /sse/events with channel subscriptions

export { router as activitiesRouter };
