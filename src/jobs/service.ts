/**
 * Job service for CRUD operations on the jobs table.
 * Single source of truth for job state.
 */

import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database';
import { jobs } from '../models/schema';
import { redis } from '../services/redis';
import { logger } from '../utils/logger';
import type {
  CreateJobParams,
  Job,
  JobProgress,
  JobStatus,
  JobType,
} from './types';

// Stale job detection thresholds — shared with worker.ts
export const STALE_STARTED_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes since started
export const STALE_PROGRESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes since last progress

export const jobService = {
  /**
   * Create a new job. Returns null if a job already exists for the target.
   * Uses unique constraint (idx_jobs_active) to prevent duplicates.
   */
  async create(params: CreateJobParams): Promise<Job | null> {
    const { type, targetType, targetId, userId, payload = {} } = params;

    try {
      const [job] = await db
        .insert(jobs)
        .values({
          type,
          targetType,
          targetId,
          userId,
          payload,
        })
        .returning();

      // Notify workers via pub/sub
      await redis.publish(`jobs:notify:${type}`, job.id);

      logger.info({ jobId: job.id, type, targetId }, 'Job created');

      return job;
    } catch (error: unknown) {
      // Unique constraint violation = job already exists for this target
      if ((error as { code?: string }).code === '23505') {
        logger.debug(
          { type, targetId },
          'Job creation rejected: active job exists',
        );
        return null;
      }
      throw error;
    }
  },

  /**
   * Get a job by ID.
   */
  async get(jobId: string): Promise<Job | null> {
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    return job ?? null;
  },

  /**
   * Get the active job for a target (queued, processing, or paused).
   */
  async getActiveForTarget(
    type: JobType,
    targetId: string,
  ): Promise<Job | null> {
    const [job] = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          eq(jobs.targetId, targetId),
          inArray(jobs.status, ['queued', 'processing', 'paused']),
        ),
      )
      .limit(1);

    return job ?? null;
  },

  /**
   * Get jobs for a target (optionally filtered by status).
   */
  async getJobsForTarget(
    targetType: string,
    targetId: string,
    statuses?: JobStatus[],
  ): Promise<Job[]> {
    const query = db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.targetType, targetType),
          eq(jobs.targetId, targetId),
          statuses ? inArray(jobs.status, statuses) : undefined,
        ),
      )
      .orderBy(sql`${jobs.createdAt} DESC`);

    return query;
  },

  /**
   * Update job status with appropriate timestamp updates.
   */
  async updateStatus(
    jobId: string,
    status: JobStatus,
    errorMessage?: string,
  ): Promise<Job | null> {
    const updates: Partial<Job> = { status };

    if (status === 'processing') {
      updates.startedAt = new Date();
      updates.progressUpdatedAt = new Date();
    } else if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
    ) {
      updates.completedAt = new Date();
    }

    if (errorMessage !== undefined) {
      updates.errorMessage = errorMessage;
    }

    const [job] = await db
      .update(jobs)
      .set(updates)
      .where(eq(jobs.id, jobId))
      .returning();

    if (job) {
      logger.debug({ jobId, status }, 'Job status updated');
    }

    return job ?? null;
  },

  /**
   * Update job progress (also touches progress_updated_at for stale detection).
   */
  async updateProgress(
    jobId: string,
    progress: JobProgress,
  ): Promise<Job | null> {
    const [job] = await db
      .update(jobs)
      .set({
        progress,
        progressUpdatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return job ?? null;
  },

  /**
   * Save checkpoint data for job resumption.
   */
  async saveCheckpoint(
    jobId: string,
    checkpoint: Record<string, unknown>,
  ): Promise<Job | null> {
    const [job] = await db
      .update(jobs)
      .set({
        checkpoint,
        progressUpdatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return job ?? null;
  },

  /**
   * Clear checkpoint (e.g., on completion or cancellation).
   */
  async clearCheckpoint(jobId: string): Promise<void> {
    await db.update(jobs).set({ checkpoint: null }).where(eq(jobs.id, jobId));
  },

  /**
   * Increment retry count and optionally reset to queued.
   */
  async incrementRetry(jobId: string): Promise<Job | null> {
    const [job] = await db
      .update(jobs)
      .set({
        retryCount: sql`${jobs.retryCount} + 1`,
        status: 'queued',
        workerId: null,
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return job ?? null;
  },

  /**
   * Claim the job (set worker ID).
   */
  async claim(jobId: string, workerId: string): Promise<Job | null> {
    const [job] = await db
      .update(jobs)
      .set({
        status: 'processing',
        startedAt: new Date(),
        progressUpdatedAt: new Date(),
        workerId,
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return job ?? null;
  },

  /**
   * Get the most recent failed job for a target (within TTL window).
   * Used to show failure state after job completes.
   */
  async getRecentFailedForTarget(
    type: JobType,
    targetId: string,
    ttlHours = 24,
  ): Promise<Job | null> {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);

    const [job] = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          eq(jobs.targetId, targetId),
          eq(jobs.status, 'failed'),
          gt(jobs.completedAt, cutoff),
        ),
      )
      .orderBy(desc(jobs.completedAt))
      .limit(1);

    return job ?? null;
  },

  /**
   * Check if a job is stale (stuck in processing with no recent progress).
   * Uses the same thresholds as recoverStaleJobs in worker.ts.
   */
  isJobStale(job: Job): boolean {
    if (job.status !== 'processing') return false;
    if (!job.startedAt) return false;

    const now = Date.now();
    const startedAge = now - new Date(job.startedAt).getTime();
    if (startedAge < STALE_STARTED_THRESHOLD_MS) return false;

    const lastProgress = job.progressUpdatedAt
      ? new Date(job.progressUpdatedAt).getTime()
      : 0;
    const progressAge = lastProgress ? now - lastProgress : Infinity;

    return progressAge >= STALE_PROGRESS_THRESHOLD_MS;
  },
};
