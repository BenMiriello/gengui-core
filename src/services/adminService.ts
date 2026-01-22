import { db } from '../config/database';
import { users, media } from '../models/schema';
import { eq, or, ilike, sql, desc, count, inArray, and } from 'drizzle-orm';
import { redis } from './redis';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

interface UserListFilters {
  search?: string;
  role?: 'user' | 'admin';
  emailVerified?: boolean;
  limit?: number;
  offset?: number;
  includeStats?: boolean;
}

interface UserStats {
  totalMedia: number;
  totalGenerations: number;
  accountAge: number; // days
}

interface GenerationStats {
  totalGenerations: number;
  queuedGenerations: number;
  processingGenerations: number;
  completedGenerations: number;
  failedGenerations: number;
}

interface UserWithStats {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  stats?: GenerationStats;
}

interface QueueStatus {
  depth: number;
  isConnected: boolean;
  oldestJobAge?: number; // seconds
}

interface WorkerStatus {
  // Placeholder for future worker API integration (#198)
  status: 'not_implemented';
  message: string;
}

export class AdminService {
  /**
   * List all users with optional filtering and pagination
   */
  async listUsers(filters: UserListFilters = {}) {
    const {
      search,
      role,
      emailVerified,
      limit = 50,
      offset = 0,
      includeStats = false,
    } = filters;

    // Validate limit
    if (limit < 1 || limit > 100) {
      throw new BadRequestError('Limit must be between 1 and 100');
    }

    // Build where conditions
    const conditions = [];

    if (search) {
      conditions.push(
        or(
          ilike(users.email, `%${search}%`),
          ilike(users.username, `%${search}%`)
        )!
      );
    }

    if (role) {
      conditions.push(eq(users.role, role));
    }

    if (emailVerified !== undefined) {
      conditions.push(eq(users.emailVerified, emailVerified));
    }

    // Get total count
    const [{ value: totalCount }] = await db
      .select({ value: count() })
      .from(users)
      .where(conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined);

    // Get users
    const userList = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    // Optionally include generation stats
    let usersWithStats: UserWithStats[] = userList;

    if (includeStats && userList.length > 0) {
      const userIds = userList.map((u) => u.id);

      // Aggregate generation counts by status for all users in this page
      const statsQuery = await db
        .select({
          userId: media.userId,
          totalCount: count(),
          queuedCount: sql<number>`COUNT(CASE WHEN ${media.status} = 'queued' THEN 1 END)`,
          processingCount: sql<number>`COUNT(CASE WHEN ${media.status} = 'processing' THEN 1 END)`,
          completedCount: sql<number>`COUNT(CASE WHEN ${media.status} = 'completed' THEN 1 END)`,
          failedCount: sql<number>`COUNT(CASE WHEN ${media.status} = 'failed' THEN 1 END)`,
        })
        .from(media)
        .where(
          and(
            inArray(media.userId, userIds),
            eq(media.sourceType, 'generation')
          )
        )
        .groupBy(media.userId);

      // Build stats map
      const statsMap = new Map<string, GenerationStats>();
      for (const row of statsQuery) {
        statsMap.set(row.userId, {
          totalGenerations: Number(row.totalCount),
          queuedGenerations: Number(row.queuedCount),
          processingGenerations: Number(row.processingCount),
          completedGenerations: Number(row.completedCount),
          failedGenerations: Number(row.failedCount),
        });
      }

      // Attach stats to users
      usersWithStats = userList.map((u) => ({
        ...u,
        stats: statsMap.get(u.id) || {
          totalGenerations: 0,
          queuedGenerations: 0,
          processingGenerations: 0,
          completedGenerations: 0,
          failedGenerations: 0,
        },
      }));
    }

    logger.info(
      {
        filters,
        resultCount: userList.length,
        totalCount,
      },
      'Admin listed users'
    );

    return {
      users: usersWithStats,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
      },
    };
  }

  /**
   * Get detailed information about a specific user
   */
  async getUserDetails(userId: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Get user stats
    const stats = await this.getUserStats(userId);

    logger.info({ userId }, 'Admin viewed user details');

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        pendingEmail: user.pendingEmail,
        defaultImageWidth: user.defaultImageWidth,
        defaultImageHeight: user.defaultImageHeight,
        defaultStylePreset: user.defaultStylePreset,
        hiddenPresetIds: user.hiddenPresetIds,
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      stats,
    };
  }

  /**
   * Get statistics for a user
   */
  private async getUserStats(userId: string): Promise<UserStats> {
    // Get total media count
    const [{ value: totalMedia }] = await db
      .select({ value: count() })
      .from(media)
      .where(eq(media.userId, userId));

    // Get generation count
    const [{ value: totalGenerations }] = await db
      .select({ value: count() })
      .from(media)
      .where(
        sql`${media.userId} = ${userId} AND ${media.sourceType} = 'generation'`
      );

    // Get account age
    const [user] = await db
      .select({ createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const accountAge = user
      ? Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      totalMedia,
      totalGenerations,
      accountAge,
    };
  }

  /**
   * Adjust user generation limits
   * NOTE: This is a placeholder until user_balances table is implemented in prod-mvp (#228-231)
   */
  async updateUserLimits(userId: string, dailyLimit: number) {
    // Validate user exists
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Validate limit
    if (dailyLimit < 0) {
      throw new BadRequestError('Daily limit must be non-negative');
    }

    // TODO: Implement when user_balances table is created (#228-231)
    // For now, store in Redis as a temporary solution
    const limitKey = `user:${userId}:daily_limit`;
    await redis.set(limitKey, dailyLimit.toString());

    logger.info(
      {
        userId,
        dailyLimit,
      },
      'Admin updated user generation limit'
    );

    return {
      userId,
      dailyLimit,
      note: 'Limit stored in Redis temporarily - will be moved to database in prod-mvp',
    };
  }

  /**
   * Get current user limit
   */
  async getUserLimit(userId: string): Promise<number> {
    const limitKey = `user:${userId}:daily_limit`;
    const limit = await redis.get(limitKey);

    // Default to 20 if not set (matches dev-mvp spec)
    return limit ? parseInt(limit, 10) : 20;
  }

  /**
   * Get Redis queue status
   */
  async getQueueStatus(): Promise<QueueStatus> {
    const isConnected = redis.getConnectionStatus();

    if (!isConnected) {
      return {
        depth: 0,
        isConnected: false,
      };
    }

    try {
      // Get queue depth
      const depth = await redis.llen('generation:queue');

      // Get oldest job age if queue has items
      let oldestJobAge: number | undefined;
      if (depth > 0) {
        // Get the oldest job ID (rightmost item in the queue)
        const oldestJobIds = await redis.lrange('generation:queue', -1, -1);
        if (oldestJobIds.length > 0) {
          const jobData = await redis.getJob(oldestJobIds[0]);
          if (jobData && jobData.queuedAt) {
            const queuedTime = parseInt(jobData.queuedAt, 10);
            oldestJobAge = Math.floor((Date.now() - queuedTime) / 1000);
          }
        }
      }

      logger.info({ depth, oldestJobAge, isConnected }, 'Admin checked queue status');

      return {
        depth,
        isConnected: true,
        oldestJobAge,
      };
    } catch (error) {
      logger.error({ error }, 'Error getting queue status');
      throw error;
    }
  }

  /**
   * Get worker status
   * NOTE: Placeholder until worker control API is implemented (#198)
   */
  async getWorkerStatus(): Promise<WorkerStatus> {
    logger.info('Admin checked worker status (not yet implemented)');

    return {
      status: 'not_implemented',
      message: 'Worker control API not yet implemented - see issue #198',
    };
  }

  /**
   * Start worker instance
   * NOTE: Placeholder until worker control API is implemented (#198)
   */
  async startWorker(): Promise<{ success: boolean; message: string }> {
    logger.warn('Admin attempted to start worker (not yet implemented)');

    throw new BadRequestError('Worker control API not yet implemented - see issue #198');
  }

  /**
   * Stop worker instance
   * NOTE: Placeholder until worker control API is implemented (#198)
   */
  async stopWorker(): Promise<{ success: boolean; message: string }> {
    logger.warn('Admin attempted to stop worker (not yet implemented)');

    throw new BadRequestError('Worker control API not yet implemented - see issue #198');
  }
}

export const adminService = new AdminService();
