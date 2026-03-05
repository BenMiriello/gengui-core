import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import { requireAdmin } from '../middleware/auth';
import { adminService } from '../services/adminService';
import { contactService } from '../services/contact';

const router = Router();

/**
 * GET /api/admin/users
 * List all users with optional filtering and pagination
 */
router.get(
  '/admin/users',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { search, role, emailVerified, limit, offset, includeStats } =
        req.query;

      // Parse and validate query parameters
      const filters: Record<string, unknown> = {};

      if (search && typeof search === 'string') {
        filters.search = search;
      }

      if (role && (role === 'user' || role === 'admin')) {
        filters.role = role;
      }

      if (emailVerified !== undefined) {
        if (emailVerified === 'true') {
          filters.emailVerified = true;
        } else if (emailVerified === 'false') {
          filters.emailVerified = false;
        }
      }

      if (limit && typeof limit === 'string') {
        const parsedLimit = parseInt(limit, 10);
        if (!Number.isNaN(parsedLimit)) {
          filters.limit = parsedLimit;
        }
      }

      if (offset && typeof offset === 'string') {
        const parsedOffset = parseInt(offset, 10);
        if (!Number.isNaN(parsedOffset)) {
          filters.offset = parsedOffset;
        }
      }

      if (includeStats === 'true') {
        filters.includeStats = true;
      }

      const result = await adminService.listUsers(filters);
      res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * GET /api/admin/users/:id
 * Get detailed information about a specific user
 */
router.get(
  '/admin/users/:id',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          error: { message: 'User ID is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const result = await adminService.getUserDetails(id);
      res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * PATCH /api/admin/users/:id/limits
 * Adjust daily generation limits for a user
 */
router.patch(
  '/admin/users/:id/limits',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { dailyLimit } = req.body;

      if (!id) {
        res.status(400).json({
          error: { message: 'User ID is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      if (dailyLimit === undefined || typeof dailyLimit !== 'number') {
        res.status(400).json({
          error: {
            message: 'Daily limit must be a number',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const result = await adminService.updateUserLimits(id, dailyLimit);
      res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * GET /api/admin/users/:id/limits
 * Get current generation limits for a user
 */
router.get(
  '/admin/users/:id/limits',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          error: { message: 'User ID is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const dailyLimit = await adminService.getUserLimit(id);
      res.json({ userId: id, dailyLimit });
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * GET /api/admin/queue/status
 * Get Redis queue depth and status
 */
router.get(
  '/admin/queue/status',
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await adminService.getQueueStatus();
      res.json(status);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * GET /api/admin/workers/status
 * Get worker instance status
 * NOTE: Placeholder until worker control API is implemented (#198)
 */
router.get(
  '/admin/workers/status',
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await adminService.getWorkerStatus();
      res.json(status);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * POST /api/admin/workers/start
 * Start worker instance
 * NOTE: Placeholder until worker control API is implemented (#198)
 */
router.post(
  '/admin/workers/start',
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await adminService.startWorker();
      res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * POST /api/admin/workers/stop
 * Stop worker instance
 * NOTE: Placeholder until worker control API is implemented (#198)
 */
router.post(
  '/admin/workers/stop',
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await adminService.stopWorker();
      res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * GET /api/admin/usage/global
 * Get global usage statistics
 */
router.get(
  '/admin/usage/global',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query;

      const stats = await adminService.getGlobalUsage({
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
      });

      res.json(stats);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/usage/users/:userId
 * Get per-user usage statistics
 */
router.get(
  '/admin/usage/users/:userId',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const { startDate, endDate } = req.query;

      const stats = await adminService.getUserUsage(userId, {
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
      });

      res.json(stats);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/usage/top-users
 * Get top users by cost
 */
router.get(
  '/admin/usage/top-users',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate, limit } = req.query;

      const topUsers = await adminService.getTopUsersByCost({
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });

      res.json(topUsers);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/usage/recent
 * Get recent LLM operations
 */
router.get(
  '/admin/usage/recent',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit, userId } = req.query;

      const operations = await adminService.getRecentOperations({
        limit: limit ? parseInt(limit as string, 10) : undefined,
        userId: userId as string | undefined,
      });

      res.json(operations);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/users/:userId/usage-summary
 * Get quick usage summary for a user (for Users tab)
 */
router.get(
  '/admin/users/:userId/usage-summary',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
        .split('T')[0];

      const monthStats = await adminService.getUserUsage(userId, {
        startDate: startOfMonth,
      });

      res.json({
        thisMonthCost: monthStats.totalCost,
        thisMonthOperations: monthStats.totalOperations,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/admin/contacts',
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const contacts = await contactService.listPending();
      res.json(contacts);
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/admin/contacts/:id',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status, notes } = req.body;

      await contactService.markStatus(id, status, req.user?.id as string, notes);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
