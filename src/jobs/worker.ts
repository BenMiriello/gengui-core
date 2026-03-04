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
import { sseService } from '../services/sse';
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

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.workerId = `${serviceName}-${process.pid}`;
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

    // Subscribe to job notifications
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
      family: 4,
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

    // Fallback polling + stale job recovery
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

    // Initial check for pending jobs
    this.processAvailable().catch((error) => {
      logger.error(
        { error, service: this.serviceName },
        'Initial job check failed',
      );
    });

    // Initial stale job recovery
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
      }
    }
  }

  /**
   * Claim the next available job using SELECT FOR UPDATE SKIP LOCKED.
   * Prioritizes paused jobs (for resume) over queued jobs.
   */
  private async claimNextJob(): Promise<Job | null> {
    try {
      // Use raw SQL for FOR UPDATE SKIP LOCKED pattern
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

      const rows = result as unknown as Job[];
      const job = rows[0];

      if (job) {
        logger.info(
          { jobId: job.id, targetId: job.targetId, service: this.serviceName },
          'Job claimed',
        );
      }

      return job ?? null;
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
    const startedThreshold = new Date(Date.now() - STALE_STARTED_THRESHOLD_MS);
    const progressThreshold = new Date(
      Date.now() - STALE_PROGRESS_THRESHOLD_MS,
    );

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
    const job = await jobService.updateStatus(jobId, 'completed');

    if (job) {
      await jobService.clearCheckpoint(jobId);

      sseService.broadcastToDocument(job.targetId, 'job-completed', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        { jobId, targetId: job.targetId, service: this.serviceName },
        'Job completed',
      );
    }
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

      logger.info(
        { jobId, targetId: job.targetId, service: this.serviceName },
        'Job cancelled',
      );
    }
  }

  /**
   * Mark job as failed.
   */
  protected async failJob(jobId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const job = await jobService.updateStatus(jobId, 'failed', errorMessage);

    if (job) {
      sseService.broadcastToDocument(job.targetId, 'job-failed', {
        jobId,
        jobType: job.type,
        targetId: job.targetId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });

      sseService.clearDocumentBuffer(job.targetId);

      logger.error(
        {
          jobId,
          targetId: job.targetId,
          error: errorMessage,
          service: this.serviceName,
        },
        'Job failed',
      );
    }
  }
}
