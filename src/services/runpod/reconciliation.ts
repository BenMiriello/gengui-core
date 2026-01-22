import { db } from '../../config/database';
import { media, documentMedia } from '../../models/schema';
import { eq, and, or, lt, isNull } from 'drizzle-orm';
import { redis } from '../redis';
import { redisStreams } from '../redis-streams';
import { runpodClient } from './client';
import type { RunPodJobStatusResponse } from './types';
import { logger } from '../../utils/logger';
import { sseService } from '../sse';
import { RUNPOD_CONSTANTS } from './constants';

const {
  EXECUTION_TIMEOUT_MS,
  REDIS_JOB_TTL_SECONDS,
  RECONCILIATION_INTERVAL_MS,
  STALENESS_THRESHOLD_MS,
  MAX_ATTEMPTS
} = RUNPOD_CONSTANTS

/**
 * Job Reconciliation Service
 *
 * Polls for stuck/failed jobs that the worker couldn't report.
 * This is the BACKUP path - worker reports via Redis are the primary path (99% of cases).
 *
 * Handles:
 * - Worker crashes before Redis update
 * - Network failures (worker → Redis)
 * - OOMKills during generation
 * - RunPod timeouts (20s execution timeout)
 * - Worker completes but crashes before Redis update (recovers s3Key from RunPod)
 *
 * Architecture:
 * - Polls every 5s
 * - Checks jobs older than 22s (20s timeout + 2s buffer)
 * - Queries RunPod API for status
 * - Handles all RunPod statuses: COMPLETED, FAILED, TIMED_OUT, CANCELLED, etc.
 */
class JobReconciliationService {
  private isRunning = false;

  async start() {
    if (this.isRunning) {
      logger.warn('Job reconciliation service already running');
      return;
    }

    if (!runpodClient.isEnabled()) {
      logger.info('RunPod not enabled, job reconciliation service not started');
      return;
    }

    this.isRunning = true;
    logger.info(
      {
        intervalMs: RECONCILIATION_INTERVAL_MS,
        stalenessThresholdMs: STALENESS_THRESHOLD_MS
      },
      'Starting job reconciliation service...'
    );

    this.reconcileLoop();

    logger.info('Job reconciliation service started successfully');
  }

  private async reconcileLoop() {
    while (this.isRunning) {
      try {
        await this.reconcileStuckJobs();
      } catch (error) {
        logger.error({ error }, 'Error in reconciliation loop');
      }

      // Wait for next interval
      await new Promise(resolve => setTimeout(resolve, RECONCILIATION_INTERVAL_MS));
    }
  }

  private async reconcileStuckJobs() {
    const stalenessThreshold = new Date(Date.now() - STALENESS_THRESHOLD_MS);

    // Find jobs that are stuck (older than staleness threshold and still processing/queued)
    const stuckJobs = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.sourceType, 'generation'),
          or(eq(media.status, 'queued'), eq(media.status, 'processing')),
          isNull(media.cancelledAt), // Skip cancelled jobs
          lt(media.updatedAt, stalenessThreshold)
        )
      );

    if (stuckJobs.length === 0) {
      logger.debug('No stuck jobs found');
      return;
    }

    logger.info({ count: stuckJobs.length }, 'Found stuck jobs, reconciling...');

    for (const job of stuckJobs) {
      try {
        await this.reconcileJob(job);
      } catch (error) {
        logger.error({ error, mediaId: job.id }, 'Failed to reconcile job');
      }
    }
  }

  private async reconcileJob(job: typeof media.$inferSelect) {
    const mediaId = job.id;

    // Get RunPod job ID from Redis
    const runpodJobId = await redis.get(`runpod:job:${mediaId}`);

    if (!runpodJobId) {
      // Job never submitted to RunPod, or Redis expired (>1hr old)
      logger.warn(
        { mediaId, age: Date.now() - job.updatedAt.getTime() },
        'Job missing RunPod ID - never submitted or Redis expired'
      );

      // Retry if attempts remaining, otherwise mark failed
      if (job.attempts < MAX_ATTEMPTS) {
        await this.retryJob(job, 'Lost RunPod job ID');
      } else {
        await this.markFailed(job, 'Lost RunPod job ID, max attempts reached');
      }
      return;
    }

    // Query RunPod for job status
    let runpodStatus: RunPodJobStatusResponse;
    try {
      runpodStatus = await runpodClient.getJobStatus(runpodJobId);
    } catch (error) {
      logger.error(
        { error, mediaId, runpodJobId },
        'Failed to query RunPod status, will retry next cycle'
      );
      return;
    }

    logger.info(
      { mediaId, runpodJobId, runpodStatus: runpodStatus.status },
      'Retrieved RunPod job status'
    );

    // Handle based on RunPod status
    await this.handleRunPodStatus(job, runpodJobId, runpodStatus);
  }

  private async handleRunPodStatus(
    job: typeof media.$inferSelect,
    runpodJobId: string,
    runpodStatus: RunPodJobStatusResponse
  ) {
    const mediaId = job.id;

    switch (runpodStatus.status) {
      case 'COMPLETED':
        await this.handleCompleted(job, runpodStatus);
        break;

      case 'FAILED':
        await this.handleFailed(job, runpodStatus);
        break;

      case 'TIMED_OUT':
        await this.handleTimedOut(job, runpodStatus);
        break;

      case 'CANCELLED':
        await this.handleCancelled(job);
        break;

      case 'IN_QUEUE':
      case 'IN_PROGRESS':
        // Still running, but stuck in our DB (missed processing update?)
        // Update DB status if needed
        if (job.status !== 'processing') {
          logger.info({ mediaId, runpodJobId }, 'Job still running, updating status to processing');
          await db
            .update(media)
            .set({
              status: 'processing',
              updatedAt: new Date()
            })
            .where(eq(media.id, mediaId));
          await this.broadcastMediaUpdate(mediaId);
        }
        break;

      default:
        logger.warn(
          { mediaId, runpodJobId, status: runpodStatus.status },
          'Unknown RunPod status'
        );
    }
  }

  private async handleCompleted(
    job: typeof media.$inferSelect,
    runpodStatus: RunPodJobStatusResponse
  ) {
    const mediaId = job.id;
    const s3Key = runpodStatus.output?.s3Key;

    if (!s3Key) {
      // Completed but no s3Key? This shouldn't happen. Retry.
      logger.error(
        { mediaId, output: runpodStatus.output },
        'Job completed without s3Key in output, retrying'
      );

      if (job.attempts < MAX_ATTEMPTS) {
        await this.retryJob(job, 'Completed without s3Key');
      } else {
        await this.markFailed(job, 'Completed without s3Key, max attempts reached');
      }
      return;
    }

    // Successfully completed - recover from RunPod output
    logger.info(
      { mediaId, s3Key },
      'Recovered completed job from RunPod (worker likely crashed before Redis update)'
    );

    await db
      .update(media)
      .set({
        status: 'completed',
        s3Key,
        updatedAt: new Date()
      })
      .where(eq(media.id, mediaId));

    // Also push to Redis completed stream for live clients
    // (in case consumer is still waiting on it)
    await redisStreams.add('generation:completed:stream', {
      mediaId,
      s3Key,
      timestamp: new Date().toISOString()
    });

    await this.broadcastMediaUpdate(mediaId);
  }

  private async handleFailed(
    job: typeof media.$inferSelect,
    runpodStatus: RunPodJobStatusResponse
  ) {
    const mediaId = job.id;
    const error = runpodStatus.error || 'Unknown error from RunPod';

    logger.error({ mediaId, error }, 'Job failed on RunPod');

    if (job.attempts < MAX_ATTEMPTS) {
      await this.retryJob(job, error);
    } else {
      await this.markFailed(job, error);
    }
  }

  private async handleTimedOut(
    job: typeof media.$inferSelect,
    runpodStatus: RunPodJobStatusResponse
  ) {
    const mediaId = job.id;
    const executionTime = runpodStatus.executionTime || 'unknown';

    logger.error(
      { mediaId, executionTime },
      'Job timed out on RunPod (exceeded execution timeout)'
    );

    if (job.attempts < MAX_ATTEMPTS) {
      await this.retryJob(job, `Timed out after ${executionTime}ms`);
    } else {
      await this.markFailed(job, `Timed out after ${executionTime}ms, max attempts reached`);
    }
  }

  private async handleCancelled(job: typeof media.$inferSelect) {
    const mediaId = job.id;

    // RunPod shows cancelled, ensure our DB reflects this
    logger.info({ mediaId }, 'Job cancelled on RunPod');

    await db
      .update(media)
      .set({
        status: 'failed',
        error: 'Cancelled',
        cancelledAt: job.cancelledAt || new Date(), // Set if not already set
        updatedAt: new Date()
      })
      .where(eq(media.id, mediaId));

    await this.broadcastMediaUpdate(mediaId);
  }

  private async retryJob(job: typeof media.$inferSelect, reason: string) {
    const mediaId = job.id;
    const newAttempts = job.attempts + 1;

    logger.warn(
      { mediaId, attempts: newAttempts, maxAttempts: MAX_ATTEMPTS, reason },
      'Retrying job'
    );

    // Update DB: increment attempts, reset to queued
    await db
      .update(media)
      .set({
        status: 'queued',
        attempts: newAttempts,
        error: `Retry ${newAttempts}/${MAX_ATTEMPTS}: ${reason}`,
        updatedAt: new Date()
      })
      .where(eq(media.id, mediaId));

    // Submit NEW job to RunPod (RunPod doesn't retry internally)
    try {
      const newRunpodJobId = await runpodClient.submitJob(
        {
          mediaId: job.id,
          userId: job.userId,
          prompt: job.prompt || '',
          seed: (job.seed || 0).toString(),
          width: (job.width || 1024).toString(),
          height: (job.height || 1024).toString(),
        },
        {
          executionTimeout: EXECUTION_TIMEOUT_MS,
        }
      );

      // Update Redis mapping with new RunPod job ID
      await redis.set(`runpod:job:${mediaId}`, newRunpodJobId, REDIS_JOB_TTL_SECONDS);
      await redis.set(`runpod:job:${mediaId}:submitted`, Date.now().toString(), REDIS_JOB_TTL_SECONDS);

      logger.info(
        { mediaId, newRunpodJobId, attempts: newAttempts },
        'Job retry submitted to RunPod'
      );
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to submit retry to RunPod, marking failed');
      await this.markFailed(job, `Retry submission failed: ${error}`);
      return;
    }

    await this.broadcastMediaUpdate(mediaId);
  }

  private async markFailed(job: typeof media.$inferSelect, reason: string) {
    const mediaId = job.id;

    logger.error(
      { mediaId, attempts: job.attempts, reason },
      'Marking job as permanently failed'
    );

    await db
      .update(media)
      .set({
        status: 'failed',
        error: reason,
        updatedAt: new Date()
      })
      .where(eq(media.id, mediaId));

    // Push to failed stream for consumer (idempotent)
    await redisStreams.add('generation:failed:stream', {
      mediaId,
      error: reason,
      timestamp: new Date().toISOString()
    });

    await this.broadcastMediaUpdate(mediaId);
  }

  private async broadcastMediaUpdate(mediaId: string) {
    try {
      const docMedia = await db
        .select({ documentId: documentMedia.documentId })
        .from(documentMedia)
        .where(eq(documentMedia.mediaId, mediaId))
        .limit(1);

      if (docMedia.length > 0) {
        const documentId = docMedia[0].documentId;
        sseService.broadcastToDocument(documentId, 'media-update', { mediaId });
        logger.debug({ mediaId, documentId }, 'Broadcasted media update via SSE');
      }
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to broadcast media update');
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping job reconciliation service...');
    this.isRunning = false;
    logger.info('Job reconciliation service stopped');
  }
}

export const jobReconciliationService = new JobReconciliationService();
