import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import { requireAdmin } from '../middleware/auth';
import { adminService } from '../services/adminService';

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
      const filters: any = {};

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

export default router;
