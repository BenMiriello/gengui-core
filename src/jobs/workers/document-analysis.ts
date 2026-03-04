/**
 * Document analysis worker.
 * Processes document analysis jobs using the multi-stage pipeline.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents } from '../../models/schema';
import {
  AnalysisCancelledError,
  AnalysisPausedError,
  multiStagePipeline,
} from '../../services/pipeline';
import { type Segment, segmentService } from '../../services/segments';
import { splitIntoSentences } from '../../services/sentences/sentence.detector';
import { sseService } from '../../services/sse';
import { stalenessService } from '../../services/staleness';
import { usageService } from '../../services/usage';
import { logger } from '../../utils/logger';
import type { AnalysisProgress, Job, JobType } from '../types';
import { JobCancelledError, JobPausedError } from '../types';
import { JobWorker } from '../worker';

const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 50000;

interface AnalysisPayload {
  reanalyze?: boolean;
  operationId?: string;
}

class DocumentAnalysisWorker extends JobWorker<
  AnalysisPayload,
  AnalysisProgress
> {
  protected jobType: JobType = 'document_analysis';

  constructor() {
    super('document-analysis-worker');
  }

  protected async processJob(
    job: Job,
    payload: AnalysisPayload,
  ): Promise<void> {
    const { reanalyze = false, operationId } = payload;
    const documentId = job.targetId;
    const userId = job.userId;

    logger.info(
      { jobId: job.id, documentId, userId, reanalyze },
      'Processing document analysis job',
    );

    let success = false;

    try {
      // Fetch and validate document
      const document = await this.fetchAndValidateDocument(documentId, userId);

      // Get segments
      const segments = await this.getDocumentSegments(documentId, document);

      // Broadcast that analysis is starting
      sseService.broadcastToDocument(documentId, 'job-status-changed', {
        jobId: job.id,
        jobType: this.jobType,
        status: 'processing',
        documentId,
        timestamp: new Date().toISOString(),
      });

      // Run multi-stage pipeline
      // The pipeline uses its own checkpoint system (documents.analysisCheckpoint)
      // and checks for interruption via document.analysisStatus
      // For now, we keep that mechanism but also set the job status
      // TODO: Migrate pipeline to use jobs table directly in Phase 5
      await db
        .update(documents)
        .set({
          analysisStatus: 'analyzing',
          analysisStartedAt: new Date(),
        })
        .where(eq(documents.id, documentId));

      const result = await multiStagePipeline.run({
        documentId,
        userId,
        documentContent: document.content,
        segments,
        versionNumber: document.currentVersion,
        documentStyle: {
          preset: document.defaultStylePreset,
          prompt: document.defaultStylePrompt,
        },
        documentTitle: document.title,
        isInitialExtraction: !reanalyze,
        broadcastProgress: true,
      });

      // Save analysis snapshot for staleness detection
      const sentences = splitIntoSentences(document.content);
      await stalenessService.saveAnalysisSnapshot({
        documentId,
        versionNumber: document.currentVersion,
        sentences: sentences.map((s, i) => ({
          index: i,
          start: s.start,
          end: s.end,
          hash: s.contentHash,
        })),
      });

      // Update lastAnalyzedVersion and clear analysis status
      await db
        .update(documents)
        .set({
          lastAnalyzedVersion: document.currentVersion,
          analysisStatus: null,
          analysisStartedAt: null,
        })
        .where(eq(documents.id, documentId));

      // Broadcast completion details
      sseService.broadcastToDocument(documentId, 'analysis-complete', {
        documentId,
        jobId: job.id,
        nodesCount: result.entityCount,
        connectionsCount: result.relationshipCount,
        threadCount: result.threadCount,
        timestamp: new Date().toISOString(),
      });

      success = true;

      logger.info(
        { jobId: job.id, documentId, ...result },
        'Document analysis completed successfully',
      );
    } catch (error) {
      // Map pipeline errors to job errors
      if (error instanceof AnalysisPausedError) {
        throw new JobPausedError(error.message);
      }
      if (error instanceof AnalysisCancelledError) {
        // Clean up analysis state
        await db
          .update(documents)
          .set({
            analysisStatus: null,
            analysisStartedAt: null,
          })
          .where(eq(documents.id, documentId));

        throw new JobCancelledError(error.message);
      }

      // Mark analysis as failed
      await db
        .update(documents)
        .set({
          analysisStatus: 'failed',
          analysisStartedAt: null,
        })
        .where(eq(documents.id, documentId));

      throw error;
    } finally {
      // Finalize usage reservation
      if (operationId) {
        await usageService.finalizeReservation({
          operationId,
          userId,
          success,
        });
      }
    }
  }

  private async fetchAndValidateDocument(
    documentId: string,
    userId: string,
  ): Promise<typeof documents.$inferSelect> {
    const [document] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .limit(1);

    if (!document) {
      throw new Error('Document not found');
    }

    const content = document.content.trim();

    if (!content) {
      throw new Error(
        'Document is empty. Please add some text before analyzing.',
      );
    }

    if (content.length < MIN_CONTENT_LENGTH) {
      throw new Error(
        `Document is too short. Please add at least ${MIN_CONTENT_LENGTH} characters of text.`,
      );
    }

    if (content.length > MAX_CONTENT_LENGTH * 100) {
      throw new Error(
        `Document is too long. The maximum length for analysis is ${MAX_CONTENT_LENGTH} characters.`,
      );
    }

    return document;
  }

  private async getDocumentSegments(
    documentId: string,
    document: { content: string; segmentSequence: unknown },
  ): Promise<Segment[]> {
    const existing = parseSegmentSequence(document.segmentSequence);
    if (existing.length > 0) {
      return existing;
    }
    return segmentService.updateDocumentSegments(documentId);
  }
}

function parseSegmentSequence(raw: unknown): Segment[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (s): s is Segment =>
        typeof s === 'object' &&
        s !== null &&
        typeof s.id === 'string' &&
        typeof s.start === 'number' &&
        typeof s.end === 'number',
    );
  }
  return [];
}

export const documentAnalysisWorker = new DocumentAnalysisWorker();
