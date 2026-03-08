/**
 * Types and interfaces for the unified job processing system.
 */

import type { jobs } from '../models/schema';

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobType =
  | 'document_analysis'
  | 'prompt_augmentation'
  | 'thumbnail_generation'
  | 'media_status_update';

export type TargetType = 'document' | 'media';

export interface CreateJobParams {
  type: JobType;
  targetType: TargetType;
  targetId: string;
  userId: string;
  payload?: Record<string, unknown>;
}

export interface JobProgress {
  stage?: number;
  totalStages?: number;
  stageName?: string;
  stageDescription?: string;
  statusHint?: string;
  entityCount?: number;
  [key: string]: unknown;
}

export interface AnalysisProgress extends JobProgress {
  stage: number;
  totalStages: number;
  stageName: string;
}

export interface AnalysisCheckpoint {
  documentVersion: number;
  lastStageCompleted: number;
  summaryData?: {
    segmentSummaries: Array<{ segmentId: string; summary: string }>;
    documentSummary: string;
  };
  stage3Progress?: {
    completedSegmentIndices: number[];
    extractedEntities: unknown[];
    entityIdByName: Record<string, string>;
    aliasToEntityId: Record<string, string>;
    mergeSignals: unknown[];
  };
  failedAtStage?: number;
  failureReason?: string;
}

/**
 * Thrown when job processing should pause (user requested).
 * Worker will save checkpoint and set status to 'paused'.
 */
export class JobPausedError extends Error {
  constructor(message = 'Job paused by user') {
    super(message);
    this.name = 'JobPausedError';
  }
}

/**
 * Thrown when job processing should stop (user cancelled).
 * Worker will clean up and set status to 'cancelled'.
 */
export class JobCancelledError extends Error {
  constructor(message = 'Job cancelled by user') {
    super(message);
    this.name = 'JobCancelledError';
  }
}
