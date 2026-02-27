/**
 * Checkpoint management for pipeline resumability.
 *
 * Stores intermediate state to allow resuming interrupted analyses.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents } from '../../models/schema';
import type { FacetType, StoryNodeType } from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import type { AnalysisStage } from './stages';

/** Existing match from LLM merge detection (name-based) */
interface ExistingMatchCheckpoint {
  matchedName: string;
  matchedType: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Merge signal for uncertain matches */
interface MergeSignalCheckpoint {
  extractedEntityName: string;
  registryName: string;
  registryType: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  segmentIndex: number;
}

export interface AnalysisCheckpoint {
  version: 1;
  documentVersion: number;
  startedAt: string;
  lastStageCompleted: AnalysisStage | null;

  failedAtStage?: AnalysisStage;
  failureReason?: string;
  failureTimestamp?: string;

  // Stage 2: Summary generation output
  summaryData?: {
    segmentSummaries: Array<{ segmentId: string; summary: string }>;
    documentSummary: string;
  };

  stage3Progress?: {
    completedSegmentIndices: number[];
    extractedEntities: Array<{
      segmentId: string;
      name: string;
      type: StoryNodeType;
      documentOrder?: number;
      facets: Array<{ type: FacetType; content: string }>;
      mentions: Array<{ text: string }>;
      existingMatch?: ExistingMatchCheckpoint;
    }>;
    entityIdByName: Record<string, string>;
    /** Maps all name variants (aliases, name facets) to entity IDs */
    aliasToEntityId?: Record<string, string>;
    mergeSignals: MergeSignalCheckpoint[];
  };

  stage3Output?: {
    extractedEntities: Array<{
      segmentId: string;
      name: string;
      type: StoryNodeType;
      documentOrder?: number;
      facets: Array<{ type: FacetType; content: string }>;
      mentions: Array<{ text: string }>;
      existingMatch?: ExistingMatchCheckpoint;
    }>;
    // LLM-first merge detection additions
    entityIdByName?: Record<string, string>;
    /** Maps all name variants (aliases, name facets) to entity IDs */
    aliasToEntityId?: Record<string, string>;
    mergeSignals?: MergeSignalCheckpoint[];
  };

  // Stage 4 output (needed for stages 5-7)
  stage4Output?: {
    entityIdByName: Record<string, string>;
  };
}

/**
 * Load checkpoint for a document.
 * Returns null if no checkpoint exists.
 */
export async function loadCheckpoint(
  documentId: string,
): Promise<AnalysisCheckpoint | null> {
  const [doc] = await db
    .select({ analysisCheckpoint: documents.analysisCheckpoint })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc?.analysisCheckpoint) {
    return null;
  }

  const checkpoint = doc.analysisCheckpoint as AnalysisCheckpoint;

  // Validate version
  if (checkpoint.version !== 1) {
    logger.warn(
      { documentId, version: checkpoint.version },
      'Unknown checkpoint version, ignoring',
    );
    return null;
  }

  return checkpoint;
}

interface CheckpointUpdate extends Partial<Omit<AnalysisCheckpoint, 'version' | 'stage3Progress' | 'failedAtStage' | 'failureReason' | 'failureTimestamp'>> {
  stage3Progress?: AnalysisCheckpoint['stage3Progress'] | null;
  failedAtStage?: AnalysisStage;
  failureReason?: string;
}

/**
 * Save or update checkpoint for a document.
 * Merges with existing checkpoint data.
 * Use `null` to explicitly clear a field.
 */
export async function saveCheckpoint(
  documentId: string,
  update: CheckpointUpdate,
): Promise<void> {
  const existing = await loadCheckpoint(documentId);

  const stage3Progress = update.stage3Progress === null
    ? undefined
    : (update.stage3Progress ?? existing?.stage3Progress);

  const checkpoint: AnalysisCheckpoint = {
    version: 1,
    documentVersion: existing?.documentVersion ?? update.documentVersion ?? 0,
    startedAt:
      existing?.startedAt ?? update.startedAt ?? new Date().toISOString(),
    lastStageCompleted:
      update.lastStageCompleted ?? existing?.lastStageCompleted ?? null,
    summaryData: update.summaryData ?? existing?.summaryData,
    stage3Progress,
    stage3Output: update.stage3Output ?? existing?.stage3Output,
    stage4Output: update.stage4Output ?? existing?.stage4Output,
    failedAtStage: update.failedAtStage ?? existing?.failedAtStage,
    failureReason: update.failureReason ?? existing?.failureReason,
    failureTimestamp: update.failedAtStage ? new Date().toISOString() : existing?.failureTimestamp,
  };

  await db
    .update(documents)
    .set({ analysisCheckpoint: checkpoint })
    .where(eq(documents.id, documentId));

  logger.debug(
    { documentId, lastStageCompleted: checkpoint.lastStageCompleted },
    'Checkpoint saved',
  );
}

/**
 * Clear checkpoint for a document.
 * Called on successful completion or when document version changes.
 */
export async function clearCheckpoint(documentId: string): Promise<void> {
  await db
    .update(documents)
    .set({ analysisCheckpoint: null })
    .where(eq(documents.id, documentId));

  logger.debug({ documentId }, 'Checkpoint cleared');
}

/**
 * Determine if a stage should run based on checkpoint state.
 */
export function shouldRunStage(
  checkpoint: AnalysisCheckpoint | null,
  stage: AnalysisStage,
): boolean {
  if (!checkpoint || checkpoint.lastStageCompleted === null) {
    return true;
  }
  return checkpoint.lastStageCompleted < stage;
}

/**
 * Check if checkpoint is valid for the current document version.
 */
export function isCheckpointValid(
  checkpoint: AnalysisCheckpoint | null,
  currentVersion: number,
): boolean {
  if (!checkpoint) {
    return false;
  }
  return checkpoint.documentVersion === currentVersion;
}
