import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../config/database';
import type { Job } from '../jobs/types';
import { activities, jobs, media } from '../models/schema';
import { logger } from '../utils/logger';
import type {
  Activity,
  ActivityProgress,
  ActivityStatus,
  ActivityType,
  CreateActivityFromJobParams,
  CreateActivityFromMediaParams,
  ListActivitiesOptions,
  UpdateActivityStatusParams,
} from './activity.types';
import { sseService } from './sse';

class ActivityService {
  /**
   * Create activity without a job (for drive import/export, etc.)
   */
  async create(params: {
    userId: string;
    activityType: ActivityType;
    targetType: 'document' | 'media';
    targetId: string;
    title: string;
  }): Promise<Activity> {
    const { userId, activityType, targetType, targetId, title } = params;

    const [activity] = await db
      .insert(activities)
      .values({
        userId,
        activityType,
        status: 'running',
        targetType,
        targetId,
        title,
      })
      .returning();

    logger.info(
      { activityId: activity.id, userId, activityType, title },
      'Activity created',
    );

    this.broadcast(userId, 'activity-created', activity);

    return activity;
  }

  /**
   * Create activity from a job (for analysis, exports, etc.)
   */
  async createFromJob(params: CreateActivityFromJobParams): Promise<Activity> {
    const { jobId, userId, activityType, targetType, targetId, title } = params;

    const [activity] = await db
      .insert(activities)
      .values({
        userId,
        activityType,
        status: 'running',
        targetType,
        targetId,
        jobId,
        title,
      })
      .returning();

    this.broadcast(userId, 'activity-created', activity);

    logger.debug(
      { activityId: activity.id, jobId, activityType },
      'Activity created from job',
    );

    return activity;
  }

  /**
   * Create activity from media (for image generation)
   */
  async createFromMedia(
    params: CreateActivityFromMediaParams,
  ): Promise<Activity> {
    const { mediaId, userId, title } = params;

    const [activity] = await db
      .insert(activities)
      .values({
        userId,
        activityType: 'image_generation',
        status: 'pending',
        targetType: 'media',
        targetId: mediaId,
        mediaId,
        title,
      })
      .returning();

    this.broadcast(userId, 'activity-created', activity);

    logger.debug(
      { activityId: activity.id, mediaId },
      'Activity created from media',
    );

    return activity;
  }

  /**
   * Update activity status
   */
  async updateStatus(
    activityId: string,
    status: ActivityStatus,
    extras?: UpdateActivityStatusParams,
  ): Promise<Activity | null> {
    logger.info({ activityId, status, extras }, 'updateStatus called');

    const updates: Partial<Activity> = {
      status,
      updatedAt: new Date(),
    };

    if (extras?.resultUrl) {
      updates.resultUrl = extras.resultUrl;
    }
    if (extras?.errorMessage) {
      updates.errorMessage = extras.errorMessage;
    }

    const [activity] = await db
      .update(activities)
      .set(updates)
      .where(eq(activities.id, activityId))
      .returning();

    if (activity) {
      logger.info(
        { activityId, status, userId: activity.userId },
        'Activity status updated, broadcasting',
      );
      this.broadcast(activity.userId, 'activity-updated', activity);
    } else {
      logger.warn({ activityId }, 'Activity not found for status update');
    }

    return activity ?? null;
  }

  /**
   * Update activity progress
   */
  async updateProgress(
    activityId: string,
    progress: ActivityProgress,
  ): Promise<Activity | null> {
    const [activity] = await db
      .update(activities)
      .set({
        progress,
        updatedAt: new Date(),
      })
      .where(eq(activities.id, activityId))
      .returning();

    if (activity) {
      this.broadcast(activity.userId, 'activity-updated', activity);
    }

    return activity ?? null;
  }

  /**
   * Mark activities as viewed
   */
  async markViewed(activityIds: string[]): Promise<void> {
    if (activityIds.length === 0) return;

    await db
      .update(activities)
      .set({ viewedAt: new Date() })
      .where(inArray(activities.id, activityIds));
  }

  /**
   * Get recent activities: all active + last 10 completed
   */
  async getRecent(userId: string): Promise<Activity[]> {
    const activeStatuses: ActivityStatus[] = ['pending', 'running'];
    const terminalStatuses: ActivityStatus[] = [
      'completed',
      'failed',
      'cancelled',
    ];

    const [activeActivities, recentCompleted] = await Promise.all([
      db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.userId, userId),
            inArray(activities.status, activeStatuses),
          ),
        )
        .orderBy(desc(activities.createdAt)),

      db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.userId, userId),
            inArray(activities.status, terminalStatuses),
          ),
        )
        .orderBy(desc(activities.createdAt))
        .limit(10),
    ]);

    return [...activeActivities, ...recentCompleted];
  }

  /**
   * List activities with pagination and filters
   */
  async list(
    userId: string,
    options: ListActivitiesOptions = {},
  ): Promise<Activity[]> {
    const { status, limit = 50, offset = 0 } = options;

    const conditions = [eq(activities.userId, userId)];
    if (status) {
      conditions.push(eq(activities.status, status));
    }

    return db
      .select()
      .from(activities)
      .where(and(...conditions))
      .orderBy(desc(activities.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Get activity by ID
   */
  async getById(activityId: string): Promise<Activity | null> {
    const [activity] = await db
      .select()
      .from(activities)
      .where(eq(activities.id, activityId))
      .limit(1);

    return activity ?? null;
  }

  /**
   * Get activity by job ID
   */
  async getByJobId(jobId: string): Promise<Activity | null> {
    const [activity] = await db
      .select()
      .from(activities)
      .where(eq(activities.jobId, jobId))
      .limit(1);

    return activity ?? null;
  }

  /**
   * Get activity by media ID
   */
  async getByMediaId(mediaId: string): Promise<Activity | null> {
    const [activity] = await db
      .select()
      .from(activities)
      .where(eq(activities.mediaId, mediaId))
      .limit(1);

    return activity ?? null;
  }

  /**
   * Retry a failed activity (creates new job/media with same params)
   */
  async retry(activityId: string, userId: string): Promise<Activity | null> {
    const activity = await this.getById(activityId);

    if (!activity) {
      throw new Error('Activity not found');
    }

    if (activity.userId !== userId) {
      throw new Error('Unauthorized');
    }

    if (activity.status !== 'failed') {
      throw new Error('Can only retry failed activities');
    }

    // For job-based activities, look up original job and recreate
    if (activity.jobId) {
      const [originalJob] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, activity.jobId))
        .limit(1);

      if (!originalJob) {
        throw new Error('Original job not found');
      }

      // Import jobService dynamically to avoid circular dependency
      const { jobService } = await import('../jobs/service.js');

      const newJob = await jobService.create({
        type: originalJob.type as
          | 'document_analysis'
          | 'prompt_augmentation'
          | 'thumbnail_generation'
          | 'media_status_update',
        targetType: originalJob.targetType as 'document' | 'media',
        targetId: originalJob.targetId,
        userId: originalJob.userId,
        payload: (originalJob.payload as Record<string, unknown>) || {},
      });

      return newJob ? this.getByJobId(newJob.id) : null;
    }

    // For media-based activities, we can't directly retry - user must regenerate
    throw new Error('Cannot retry image generation - please regenerate');
  }

  /**
   * Cancel a pending/running activity
   */
  async cancel(activityId: string, userId: string): Promise<Activity | null> {
    const activity = await this.getById(activityId);

    if (!activity) {
      throw new Error('Activity not found');
    }

    if (activity.userId !== userId) {
      throw new Error('Unauthorized');
    }

    if (activity.status !== 'pending' && activity.status !== 'running') {
      throw new Error('Can only cancel pending or running activities');
    }

    // Cancel the underlying job or media
    if (activity.jobId) {
      const { jobService } = await import('../jobs/service.js');
      await jobService.updateStatus(activity.jobId, 'cancelled');
    } else if (activity.mediaId) {
      await db
        .update(media)
        .set({
          cancelledAt: new Date(),
          status: 'failed',
          error: 'Cancelled by user',
        })
        .where(eq(media.id, activity.mediaId));
    }

    return this.updateStatus(activityId, 'cancelled');
  }

  /**
   * Cleanup old activities (older than 30 days)
   */
  async cleanup(): Promise<number> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await db
      .delete(activities)
      .where(lt(activities.createdAt, thirtyDaysAgo))
      .returning({ id: activities.id });

    if (result.length > 0) {
      logger.info({ count: result.length }, 'Cleaned up old activities');
    }

    return result.length;
  }

  /**
   * Sync orphaned activities with their job status.
   * Finds activities that are 'running' or 'pending' but their job has finished.
   */
  async syncOrphanedActivities(): Promise<number> {
    // Find activities with jobs that have a terminal status
    const orphaned = await db
      .select({
        activity: activities,
        job: jobs,
      })
      .from(activities)
      .innerJoin(jobs, eq(activities.jobId, jobs.id))
      .where(
        and(
          inArray(activities.status, ['pending', 'running']),
          inArray(jobs.status, ['completed', 'failed', 'cancelled']),
        ),
      );

    if (orphaned.length === 0) return 0;

    logger.info(
      { count: orphaned.length },
      'Found orphaned activities to sync',
    );

    let syncedCount = 0;
    for (const { activity, job } of orphaned) {
      const newStatus: ActivityStatus =
        job.status === 'completed'
          ? 'completed'
          : job.status === 'cancelled'
            ? 'cancelled'
            : 'failed';

      const extras: UpdateActivityStatusParams = {};
      if (job.status === 'failed' && job.errorMessage) {
        extras.errorMessage = job.errorMessage;
      }

      try {
        await this.updateStatus(activity.id, newStatus, extras);
        syncedCount++;
        logger.info(
          { activityId: activity.id, jobId: job.id, newStatus },
          'Synced orphaned activity',
        );
      } catch (error) {
        logger.error(
          { error, activityId: activity.id },
          'Failed to sync orphaned activity',
        );
      }
    }

    return syncedCount;
  }

  /**
   * Broadcast activity event to user channel
   */
  broadcast(userId: string, eventType: string, activity: Activity): void {
    logger.info(
      {
        userId,
        eventType,
        activityId: activity.id,
        activityType: activity.activityType,
        status: activity.status,
      },
      'Broadcasting activity event',
    );
    sseService.broadcast(`user:${userId}`, eventType, activity);
  }

  /**
   * Get activity type from job type
   */
  getActivityTypeFromJobType(jobType: Job['type']): ActivityType | null {
    const mapping: Record<string, ActivityType> = {
      document_analysis: 'document_analysis',
      pdf_export: 'pdf_export',
      docx_export: 'docx_export',
    };

    return mapping[jobType] ?? null;
  }
}

export const activityService = new ActivityService();
