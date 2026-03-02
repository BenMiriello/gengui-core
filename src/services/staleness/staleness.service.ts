/**
 * Staleness detection service.
 * Compares current document sentences against analysis snapshot to detect changes.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../config/database';
import { analysisSnapshots, documents } from '../../models/schema';
import { logger } from '../../utils/logger';
import { splitIntoSentences } from '../sentences/sentence.detector';
import type {
  AnalysisSnapshotInput,
  SentenceHash,
  StalenessResult,
  StaleRegion,
} from './staleness.types';

export const stalenessService = {
  /**
   * Save sentence hashes from an analysis run.
   * Called after successful analysis completion.
   */
  async saveAnalysisSnapshot(input: AnalysisSnapshotInput): Promise<void> {
    const { documentId, versionNumber, sentences } = input;

    if (sentences.length === 0) {
      logger.debug({ documentId, versionNumber }, 'No sentences to snapshot');
      return;
    }

    // Delete any existing snapshot for this version
    await db
      .delete(analysisSnapshots)
      .where(
        and(
          eq(analysisSnapshots.documentId, documentId),
          eq(analysisSnapshots.versionNumber, versionNumber),
        ),
      );

    // Insert new snapshot entries
    const values = sentences.map((s) => ({
      documentId,
      versionNumber,
      sentenceIndex: s.index,
      sentenceStart: s.start,
      sentenceEnd: s.end,
      contentHash: s.hash,
    }));

    await db.insert(analysisSnapshots).values(values);

    logger.info(
      { documentId, versionNumber, sentenceCount: sentences.length },
      'Analysis snapshot saved',
    );
  },

  /**
   * Get sentence hashes from a previous analysis.
   */
  async getAnalysisSnapshot(
    documentId: string,
    versionNumber: number,
  ): Promise<SentenceHash[]> {
    const rows = await db
      .select({
        index: analysisSnapshots.sentenceIndex,
        start: analysisSnapshots.sentenceStart,
        end: analysisSnapshots.sentenceEnd,
        hash: analysisSnapshots.contentHash,
      })
      .from(analysisSnapshots)
      .where(
        and(
          eq(analysisSnapshots.documentId, documentId),
          eq(analysisSnapshots.versionNumber, versionNumber),
        ),
      )
      .orderBy(analysisSnapshots.sentenceIndex);

    return rows;
  },

  /**
   * Detect stale regions by comparing current content against last analysis.
   * Returns regions that have been modified or added since analysis.
   */
  async detectStaleness(
    documentId: string,
    currentContent: string,
  ): Promise<StalenessResult> {
    // Get document to find last analyzed version
    const [doc] = await db
      .select({
        lastAnalyzedVersion: documents.lastAnalyzedVersion,
      })
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc?.lastAnalyzedVersion) {
      return {
        staleRegions: [],
        sentenceCount: 0,
        changedSentenceCount: 0,
        lastAnalyzedVersion: null,
      };
    }

    // Get snapshot from last analysis
    const snapshot = await this.getAnalysisSnapshot(
      documentId,
      doc.lastAnalyzedVersion,
    );

    if (snapshot.length === 0) {
      return {
        staleRegions: [],
        sentenceCount: 0,
        changedSentenceCount: 0,
        lastAnalyzedVersion: doc.lastAnalyzedVersion,
      };
    }

    // Split current content into sentences
    const currentSentences = splitIntoSentences(currentContent);
    const snapshotHashes = new Set(snapshot.map((s) => s.hash));

    const staleRegions: StaleRegion[] = [];

    for (let i = 0; i < currentSentences.length; i++) {
      const sentence = currentSentences[i];

      if (!snapshotHashes.has(sentence.contentHash)) {
        staleRegions.push({
          charStart: sentence.start,
          charEnd: sentence.end,
          sentenceIndex: i,
          changeType: 'changed',
        });
      }
    }

    return {
      staleRegions,
      sentenceCount: currentSentences.length,
      changedSentenceCount: staleRegions.length,
      lastAnalyzedVersion: doc.lastAnalyzedVersion,
    };
  },

  /**
   * Delete all snapshots for a document.
   */
  async deleteSnapshotsForDocument(documentId: string): Promise<void> {
    await db
      .delete(analysisSnapshots)
      .where(eq(analysisSnapshots.documentId, documentId));
  },

  /**
   * Delete snapshots for specific versions.
   */
  async deleteSnapshotsForVersions(
    documentId: string,
    versions: number[],
  ): Promise<void> {
    if (versions.length === 0) return;

    await db
      .delete(analysisSnapshots)
      .where(
        and(
          eq(analysisSnapshots.documentId, documentId),
          inArray(analysisSnapshots.versionNumber, versions),
        ),
      );
  },
};
