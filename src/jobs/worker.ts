/**
 * Abstract base class for job workers.
 *
 * Workers poll the database for available jobs, claim them using
 * SELECT FOR UPDATE SKIP LOCKED, and process them.
 *
 * Redis pub/sub is used only for notifications to reduce polling latency.
 */

import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../config/database';
import { jobs } from '../models/schema';
import { activityService } from '../services/activity.service';
import type { Activity, ActivityProgress } from '../services/activity.types';
import { sseService } from '../services/sse';
import { getErrorForLogging, sanitizeError } from '../utils/error-sanitizer';
import { logger } from '../utils/logger';
import { jobService } from './service';
import type { Job, JobProgress, JobType } from './types';
import { JobCancelledError, JobPausedError } from './types';

// Stale job detection thresholds
const STALE_STARTED_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes since started
const STALE_PROGRESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes since last progress

// Poll interval for checking jobs (fallback when no pub/sub notification)
const POLL_INTERVAL_MS = 30_000;

export abstract class JobWorker<
  TPayload = unknown,
  TProgress extends JobProgress = JobProgress,
> {
  protected abstract jobType: JobType;
  protected abstract processJob(job: Job, payload: TPayload): Promise<void>;

  private isRunning = false;
  private subscriber: Redis | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private processingPromise: Promise<void> | null = null;

  protected readonly workerId: string;
  protected readonly serviceName: string;

  // Track current activity for the job being processed
  private currentActivity: Activity | null = null;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.workerId = `${serviceName}-${process.pid}`;
  }

  /**
   * Override in subclass to provide activity title for this job.
   * Return null to skip activity tracking for this job type.
   */
  protected getActivityTitle(_job: Job, _payload: TPayload): string | null {
    return null;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn({ service: this.serviceName }, 'Worker already running');
      return;
    }

    this.isRunning = true;
    logger.info(
      { service: this.serviceName, workerId: this.workerId },
      'Starting job worker',
    );

    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
      commandTimeout: 15000,
      connectTimeout: 10000,
      family: 4,
      keepAlive: 30000,
      blockingTimeout: 30000,
      autoResubscribe: true,
    });

    this.subscriber.on('error', (error) => {
      logger.error({ error, service: this.serviceName }, 'Subscriber error');
    });

    const channel = `jobs:notify:${this.jobType}`;
    await this.subscriber.subscribe(channel);

    this.subscriber.on('message', async (ch) => {
      if (ch === channel && this.isRunning && !this.processingPromise) {
        this.processingPromise = this.processAvailable();
        await this.processingPromise;
        this.processingPromise = null;
      }
    });

    this.pollInterval = setInterval(async () => {
      if (this.isRunning && !this.processingPromise) {
        this.processingPromise = (async () => {
          await this.recoverStaleJobs();
          await this.processAvailable();
        })();
        await this.processingPromise;
        this.processingPromise = null;
      }
    }, POLL_INTERVAL_MS);

    this.processAvailable().catch((error) => {
      logger.error(
        { error, service: this.serviceName },
        'Initial job check failed',
      );
    });

    this.recoverStaleJobs().catch((error) => {
      logger.error(
        { error, service: this.serviceName },
        'Initial stale recovery failed',
      );
    });

    logger.info({ service: this.serviceName, channel }, 'Job worker started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info({ service: this.serviceName }, 'Stopping job worker');
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe();
      } catch {
        // Ignore errors during shutdown
      }
      this.subscriber.disconnect();
      this.subscriber = null;
    }

    // Wait for in-flight processing
    if (this.processingPromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn(
            { service: this.serviceName },
            'Processing did not complete in time',
          );
          resolve();
        }, 5000);
      });
      await Promise.race([this.processingPromise, timeout]);
    }

    logger.info({ service: this.serviceName }, 'Job worker stopped');
  }

  /**
   * Process all available jobs until none remain.
   */
  private async processAvailable(): Promise<void> {
    while (this.isRunning) {
      const job = await this.claimNextJob();
      if (!job) break;

      // Create activity if this job type supports it
      await this.createActivityForJob(job);

      try {
        await this.processJob(job, job.payload as TPayload);
        await this.completeJob(job.id);
      } catch (error) {
        if (error instanceof JobPausedError) {
          await this.pauseJob(job.id);
        } else if (error instanceof JobCancelledError) {
          await this.cancelJob(job.id);
        } else {
          await this.failJob(job.id, error);
        }
      } finally {
        this.currentActivity = null;
      }
    }
  }

  /**
   * Create activity for job if applicable.
   */
  private async createActivityForJob(job: Job): Promise<void> {
    const payload = job.payload as TPayload;
    const title = this.getActivityTitle(job, payload);

    if (!title) {
      logger.debug(
        { jobId: job.id },
        'No activity title, skipping activity creation',
      );
      this.currentActivity = null;
      return;
    }

    const activityType = activityService.getActivityTypeFromJobType(job.type);
    if (!activityType) {
      logger.debug(
        { jobId: job.id, jobType: job.type },
        'No activity type mapping, skipping activity creation',
      );
      this.currentActivity = null;
      return;
    }

    try {
      this.currentActivity = await activityService.createFromJob({
        jobId: job.id,
        userId: job.userId,
        activityType,
        targetType: job.targetType,
        targetId: job.targetId,
        title,
      });
      logger.info(
        { jobId: job.id, activityId: this.currentActivity.id, activityType },
        'Activity created for job',
      );
    } catch (error) {
      logger.error(
        { error, jobId: job.id },
        'Failed to create activity for job',
      );
      this.currentActivity = null;
    }
  }

  /**
   * Claim the next available job using SELECT FOR UPDATE SKIP LOCKED.
   * Prioritizes paused jobs (for resume) over queued jobs.
   */
  private async claimNextJob(): Promise<Job | null> {
    try {
      // Use raw SQL for FOR UPDATE SKIP LOCKED pattern
      // Returns snake_case columns, must map to camelCase
      const result = await db.execute(sql`
        UPDATE jobs
        SET status = 'processing',
            started_at = NOW(),
            progress_updated_at = NOW(),
            worker_id = ${this.workerId}
        WHERE id = (
          SELECT id FROM jobs
          WHERE type = ${this.jobType}
            AND status IN ('queued', 'paused')
          ORDER BY
            CASE WHEN status = 'paused' THEN 0 ELSE 1 END,
            created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);

      const rows = result as unknown as Array<Record<string, unknown>>;
      const row = rows[0];

      if (!row) return null;

      // Map snake_case DB columns to camelCase Job type
      const job: Job = {
        id: row.id as string,
        type: row.type as Job['type'],
        status: row.status as Job['status'],
        userId: row.user_id as string,
        targetType: row.target_type as string,
        targetId: row.target_id as string,
        payload: row.payload as Record<string, unknown>,
        progress: row.progress as Record<string, unknown> | null,
        progressUpdatedAt: row.progress_updated_at as Date | null,
        checkpoint: row.checkpoint as Record<string, unknown> | null,
        createdAt: row.created_at as Date,
        startedAt: row.started_at as Date | null,
        completedAt: row.completed_at as Date | null,
        errorMessage: row.error_message as string | null,
        retryCount: row.retry_count as number,
        maxRetries: row.max_retries as number,
        workerId: row.worker_id as string | null,
      };

      logger.info(
        { jobId: job.id, targetId: job.targetId, service: this.serviceName },
        'Job claimed',
      );

      return job;
    } catch (error) {
      logger.error({ error, service: this.serviceName }, 'Failed to claim job');
      return null;
    }
  }

  /**
   * Recover stale jobs that appear to have crashed.
   * Uses progress stall detection with two thresholds:
   * - Job started > 10 minutes ago
   * - No progress update in last 5 minutes (or never had one)
   */
  protected async recoverStaleJobs(): Promise<void> {
    const startedThreshold = new Date(
      Date.now() - STALE_STARTED_THRESHOLD_MS,
    ).toISOString();
    const progressThreshold = new Date(
      Date.now() - STALE_PROGRESS_THRESHOLD_MS,
    ).toISOString();

    try {
      const result = await db.execute(sql`
        UPDATE jobs
        SET status = 'queued',
            worker_id = NULL,
            retry_count = retry_count + 1
        WHERE type = ${this.jobType}
          AND status = 'processing'
          AND started_at < ${startedThreshold}
          AND (progress_updated_at IS NULL OR progress_updated_at < ${progressThreshold})
          AND retry_count < max_retries
        RETURNING id
      `);

      const rows = result as unknown as { id: string }[];

      if (rows.length > 0) {
        logger.info(
          {
            jobIds: rows.map((r) => r.id),
            count: rows.length,
            service: this.serviceName,
          },
          'Recovered stale jobs',
        );
      }
    } catch (error) {
      logger.error(
        { error, service: this.serviceName },
        'Failed to recover stale jobs',
      );
    }
  }

  /**
   * Update progress and broadcast to SSE subscribers.
   */
  protected async updateProgress(
    jobId: string,
    progress: TProgress,
  ): Promise<void> {
    const job = await jobService.updateProgress(jobId, progress);

    if (job) {
      sseService.broadcastToDocument(job.targetId, 'job-progress', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        progress,
        timestamp: new Date().toISOString(),
      });

      // Update activity progress if we have one
      if (this.currentActivity) {
        const activityProgress: ActivityProgress = {
          stage: progress.stage,
          totalStages: progress.totalStages,
          stageName: progress.stageName,
        };
        await activityService.updateProgress(
          this.currentActivity.id,
          activityProgress,
        );
      }
    }
  }

  /**
   * Save checkpoint for job resumption.
   */
  protected async saveCheckpoint(
    jobId: string,
    checkpoint: Record<string, unknown>,
  ): Promise<void> {
    await jobService.saveCheckpoint(jobId, checkpoint);
  }

  /**
   * Check if the job has been paused or cancelled.
   * Call this at stage/batch boundaries during processing.
   */
  protected async checkInterruption(jobId: string): Promise<void> {
    const [job] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (job?.status === 'cancelled') {
      throw new JobCancelledError();
    }

    if (job?.status === 'paused') {
      throw new JobPausedError();
    }
  }

  /**
   * Mark job as completed.
   */
  protected async completeJob(jobId: string): Promise<void> {
    logger.info(
      {
        jobId,
        hasActivity: !!this.currentActivity,
        activityId: this.currentActivity?.id,
      },
      'completeJob called',
    );

    const job = await jobService.updateStatus(jobId, 'completed');

    if (job) {
      await jobService.clearCheckpoint(jobId);

      sseService.broadcastToDocument(job.targetId, 'job-completed', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        timestamp: new Date().toISOString(),
      });

      // Update activity status
      if (this.currentActivity) {
        const resultUrl = this.getResultUrl(job);
        logger.info(
          { jobId, activityId: this.currentActivity.id, resultUrl },
          'Updating activity status to completed',
        );
        try {
          await activityService.updateStatus(
            this.currentActivity.id,
            'completed',
            {
              resultUrl,
            },
          );
          logger.info(
            { jobId, activityId: this.currentActivity.id },
            'Activity status update succeeded',
          );
        } catch (error) {
          logger.error(
            { error, jobId, activityId: this.currentActivity.id },
            'Failed to update activity status to completed',
          );
        }
      } else {
        logger.warn(
          { jobId },
          'No currentActivity to update on job completion',
        );
      }

      logger.info(
        { jobId, targetId: job.targetId, service: this.serviceName },
        'Job completed',
      );
    } else {
      logger.warn({ jobId }, 'Job not found when completing');
    }
  }

  /**
   * Override in subclass to provide result URL for completed jobs.
   */
  protected getResultUrl(_job: Job): string | undefined {
    return undefined;
  }

  /**
   * Mark job as paused (keeps checkpoint).
   */
  protected async pauseJob(jobId: string): Promise<void> {
    const job = await jobService.updateStatus(jobId, 'paused');

    if (job) {
      sseService.broadcastToDocument(job.targetId, 'job-paused', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        timestamp: new Date().toISOString(),
      });

      // Activity stays in 'running' state when paused (user can resume)

      logger.info(
        { jobId, targetId: job.targetId, service: this.serviceName },
        'Job paused',
      );
    }
  }

  /**
   * Mark job as cancelled (clears checkpoint).
   */
  protected async cancelJob(jobId: string): Promise<void> {
    const job = await jobService.updateStatus(jobId, 'cancelled');

    if (job) {
      await jobService.clearCheckpoint(jobId);

      sseService.broadcastToDocument(job.targetId, 'job-cancelled', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        timestamp: new Date().toISOString(),
      });

      sseService.clearDocumentBuffer(job.targetId);

      // Update activity status
      if (this.currentActivity) {
        try {
          await activityService.updateStatus(
            this.currentActivity.id,
            'cancelled',
          );
        } catch (error) {
          logger.error(
            { error, jobId, activityId: this.currentActivity.id },
            'Failed to update activity status to cancelled',
          );
        }
      }

      logger.info(
        { jobId, targetId: job.targetId, service: this.serviceName },
        'Job cancelled',
      );
    }
  }

  /**
   * Mark job as failed.
   * Sanitizes error messages for user display while preserving full details for logging.
   */
  protected async failJob(jobId: string, error: unknown): Promise<void> {
    const rawError = getErrorForLogging(error);
    const userMessage = sanitizeError(error);

    // Store sanitized message in DB (visible via admin/debugging)
    const job = await jobService.updateStatus(
      jobId,
      'failed',
      rawError.message,
    );

    if (job) {
      // Send sanitized message to user via SSE
      sseService.broadcastToDocument(job.targetId, 'job-failed', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        error: userMessage,
        timestamp: new Date().toISOString(),
      });

      sseService.clearDocumentBuffer(job.targetId);

      // Update activity with sanitized message (user-visible)
      if (this.currentActivity) {
        try {
          await activityService.updateStatus(
            this.currentActivity.id,
            'failed',
            {
              errorMessage: userMessage,
            },
          );
        } catch (activityError) {
          logger.error(
            {
              error: activityError,
              jobId,
              activityId: this.currentActivity.id,
            },
            'Failed to update activity status to failed',
          );
        }
      }

      // Log full error details for debugging
      logger.error(
        {
          jobId,
          targetId: job.targetId,
          error: rawError.message,
          stack: rawError.stack,
          service: this.serviceName,
        },
        'Job failed',
      );
    }
  }
}
