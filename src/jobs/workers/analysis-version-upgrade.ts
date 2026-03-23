/**
 * Analysis version upgrade worker.
 * Upgrades document embeddings from one analysis version to another.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents } from '../../models/schema';
import { generateEmbeddingsForVersion } from '../../services/embeddings';
import { graphService } from '../../services/graph/graph.service';
import { mentionService } from '../../services/mentions';
import { sseService } from '../../services/sse';
import { logger } from '../../utils/logger';
import type {
  Job,
  JobType,
  VersionUpgradeCheckpoint,
  VersionUpgradeProgress,
} from '../types';
import { JobPausedError } from '../types';
import { JobWorker } from '../worker';

const FACET_BATCH_SIZE = 50;

interface UpgradePayload {
  fromVersion: string;
  toVersion: string;
  documentTitle: string;
}

const STAGE_NAMES = [
  '', // 0-indexed padding
  'Enumerating entities',
  'Regenerating facet embeddings',
  'Recomputing entity embeddings',
  'Finalizing upgrade',
];

class AnalysisVersionUpgradeWorker extends JobWorker<
  UpgradePayload,
  VersionUpgradeProgress
> {
  protected jobType: JobType = 'analysis_version_upgrade';

  constructor() {
    super('analysis-version-upgrade-worker');
  }

  protected getActivityTitle(
    _job: Job,
    payload: UpgradePayload,
  ): string | null {
    return `Updating "${payload.documentTitle}" to v${payload.toVersion}`;
  }

  protected getResultUrl(job: Job): string {
    return `/documents/${job.targetId}`;
  }

  protected async processJob(job: Job, payload: UpgradePayload): Promise<void> {
    const { fromVersion, toVersion } = payload;
    const documentId = job.targetId;
    const userId = job.userId;

    logger.info(
      { jobId: job.id, documentId, userId, fromVersion, toVersion },
      'Processing analysis version upgrade job',
    );

    // Load or initialize checkpoint
    const checkpoint: VersionUpgradeCheckpoint =
      (job.checkpoint as VersionUpgradeCheckpoint) || {
        fromVersion,
        toVersion,
        lastStageCompleted: 0,
        facetIds: [],
        entityIds: [],
        processedFacetIds: [],
        processedEntityIds: [],
      };

    try {
      // Set document status to upgrading
      await db
        .update(documents)
        .set({ analysisStatus: 'upgrading' })
        .where(eq(documents.id, documentId));

      // Broadcast start
      sseService.broadcastToDocument(documentId, 'job-status-changed', {
        jobId: job.id,
        jobType: this.jobType,
        status: 'processing',
        documentId,
        timestamp: new Date().toISOString(),
      });

      // Stage 1: Enumerate entities and facets
      if (checkpoint.lastStageCompleted < 1) {
        await this.updateProgress(job.id, {
          stage: 1,
          totalStages: 4,
          stageName: STAGE_NAMES[1],
          facetsProcessed: 0,
          totalFacets: 0,
          entitiesProcessed: 0,
          totalEntities: 0,
        });

        const nodes = await graphService.getStoryNodesForDocument(
          documentId,
          userId,
        );
        checkpoint.entityIds = nodes.map((n) => n.id);

        // Collect all facet IDs
        const allFacetIds: string[] = [];
        for (const node of nodes) {
          const facets = await graphService.getFacetsForEntity(
            node.id,
            fromVersion,
          );
          allFacetIds.push(...facets.map((f) => f.id));
        }
        checkpoint.facetIds = allFacetIds;

        checkpoint.lastStageCompleted = 1;
        await this.saveCheckpoint(
          job.id,
          checkpoint as Record<string, unknown>,
        );

        logger.info(
          {
            jobId: job.id,
            entityCount: checkpoint.entityIds.length,
            facetCount: checkpoint.facetIds.length,
          },
          'Stage 1 complete: enumerated entities and facets',
        );
      }

      await this.checkInterruption(job.id);

      // Stage 2: Regenerate facet embeddings
      if (checkpoint.lastStageCompleted < 2) {
        const processedSet = new Set(checkpoint.processedFacetIds);
        const remainingFacetIds = checkpoint.facetIds.filter(
          (id) => !processedSet.has(id),
        );

        await this.updateProgress(job.id, {
          stage: 2,
          totalStages: 4,
          stageName: STAGE_NAMES[2],
          facetsProcessed: checkpoint.processedFacetIds.length,
          totalFacets: checkpoint.facetIds.length,
          entitiesProcessed: 0,
          totalEntities: checkpoint.entityIds.length,
        });

        // Process facets in batches
        for (let i = 0; i < remainingFacetIds.length; i += FACET_BATCH_SIZE) {
          await this.checkInterruption(job.id);

          const batchIds = remainingFacetIds.slice(i, i + FACET_BATCH_SIZE);

          // Get facet contents
          const facetContents: Array<{ id: string; content: string }> = [];
          for (const facetId of batchIds) {
            const facet = await graphService.getFacetById(facetId);
            if (facet) {
              facetContents.push({ id: facet.id, content: facet.content });
            }
          }

          // Generate embeddings in batch
          const embeddings = await generateEmbeddingsForVersion(
            facetContents.map((f) => f.content),
            toVersion,
          );

          // Write embeddings to new column
          for (let j = 0; j < facetContents.length; j++) {
            await graphService.setFacetEmbedding(
              facetContents[j].id,
              embeddings[j],
              toVersion,
            );
          }

          // Update checkpoint
          checkpoint.processedFacetIds.push(...batchIds);
          await this.saveCheckpoint(
            job.id,
            checkpoint as Record<string, unknown>,
          );

          await this.updateProgress(job.id, {
            stage: 2,
            totalStages: 4,
            stageName: STAGE_NAMES[2],
            facetsProcessed: checkpoint.processedFacetIds.length,
            totalFacets: checkpoint.facetIds.length,
            entitiesProcessed: 0,
            totalEntities: checkpoint.entityIds.length,
          });
        }

        checkpoint.lastStageCompleted = 2;
        await this.saveCheckpoint(
          job.id,
          checkpoint as Record<string, unknown>,
        );

        logger.info(
          { jobId: job.id, facetCount: checkpoint.facetIds.length },
          'Stage 2 complete: regenerated facet embeddings',
        );
      }

      await this.checkInterruption(job.id);

      // Stage 3: Recompute entity embeddings from facets
      if (checkpoint.lastStageCompleted < 3) {
        const processedSet = new Set(checkpoint.processedEntityIds);
        const remainingEntityIds = checkpoint.entityIds.filter(
          (id) => !processedSet.has(id),
        );

        await this.updateProgress(job.id, {
          stage: 3,
          totalStages: 4,
          stageName: STAGE_NAMES[3],
          facetsProcessed: checkpoint.facetIds.length,
          totalFacets: checkpoint.facetIds.length,
          entitiesProcessed: checkpoint.processedEntityIds.length,
          totalEntities: checkpoint.entityIds.length,
        });

        for (const entityId of remainingEntityIds) {
          await this.checkInterruption(job.id);

          // Get facets with NEW embeddings
          const facets = await graphService.getFacetsForEntity(
            entityId,
            toVersion,
          );
          const mentionCounts =
            await mentionService.getMentionCountsByFacet(entityId);

          // Build weighted embedding
          const facetEmbeddings: Array<{
            embedding: number[];
            weight: number;
          }> = [];
          for (const facet of facets) {
            if (!facet.embedding) continue;
            const mentionCount = mentionCounts.get(facet.id) || 1;
            const typeBonus = facet.type === 'name' ? 2.0 : 1.0;
            facetEmbeddings.push({
              embedding: facet.embedding,
              weight: mentionCount * typeBonus,
            });
          }

          if (facetEmbeddings.length > 0) {
            const entityEmbedding =
              this.computeWeightedAverageEmbedding(facetEmbeddings);
            await graphService.setNodeEmbedding(
              entityId,
              entityEmbedding,
              toVersion,
            );
          }

          checkpoint.processedEntityIds.push(entityId);
          await this.saveCheckpoint(
            job.id,
            checkpoint as Record<string, unknown>,
          );

          await this.updateProgress(job.id, {
            stage: 3,
            totalStages: 4,
            stageName: STAGE_NAMES[3],
            facetsProcessed: checkpoint.facetIds.length,
            totalFacets: checkpoint.facetIds.length,
            entitiesProcessed: checkpoint.processedEntityIds.length,
            totalEntities: checkpoint.entityIds.length,
          });
        }

        checkpoint.lastStageCompleted = 3;
        await this.saveCheckpoint(
          job.id,
          checkpoint as Record<string, unknown>,
        );

        logger.info(
          { jobId: job.id, entityCount: checkpoint.entityIds.length },
          'Stage 3 complete: recomputed entity embeddings',
        );
      }

      await this.checkInterruption(job.id);

      // Stage 4: Update analysisVersion and clean up
      if (checkpoint.lastStageCompleted < 4) {
        await this.updateProgress(job.id, {
          stage: 4,
          totalStages: 4,
          stageName: STAGE_NAMES[4],
          facetsProcessed: checkpoint.facetIds.length,
          totalFacets: checkpoint.facetIds.length,
          entitiesProcessed: checkpoint.entityIds.length,
          totalEntities: checkpoint.entityIds.length,
        });

        // Atomically update analysisVersion and clear status
        await db
          .update(documents)
          .set({
            analysisVersion: toVersion,
            analysisStatus: null,
          })
          .where(eq(documents.id, documentId));

        checkpoint.lastStageCompleted = 4;
        await this.saveCheckpoint(
          job.id,
          checkpoint as Record<string, unknown>,
        );

        logger.info(
          { jobId: job.id, toVersion },
          'Stage 4 complete: finalized',
        );
      }

      // Broadcast completion
      sseService.broadcastToDocument(documentId, 'version-upgrade-complete', {
        documentId,
        jobId: job.id,
        fromVersion,
        toVersion,
        entityCount: checkpoint.entityIds.length,
        facetCount: checkpoint.facetIds.length,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        {
          jobId: job.id,
          documentId,
          fromVersion,
          toVersion,
          entityCount: checkpoint.entityIds.length,
          facetCount: checkpoint.facetIds.length,
        },
        'Analysis version upgrade completed successfully',
      );
    } catch (error) {
      // Always clear analysisStatus on error (unless paused)
      if (!(error instanceof JobPausedError)) {
        await db
          .update(documents)
          .set({ analysisStatus: null })
          .where(eq(documents.id, documentId));
      }

      throw error;
    }
  }

  private computeWeightedAverageEmbedding(
    facetEmbeddings: Array<{ embedding: number[]; weight: number }>,
  ): number[] {
    if (facetEmbeddings.length === 0) return [];
    if (facetEmbeddings.length === 1) return facetEmbeddings[0].embedding;

    const dimensions = facetEmbeddings[0].embedding.length;
    const totalWeight = facetEmbeddings.reduce((sum, f) => sum + f.weight, 0);
    const result = new Array(dimensions).fill(0);

    for (const { embedding, weight } of facetEmbeddings) {
      const normalizedWeight = weight / totalWeight;
      for (let i = 0; i < dimensions; i++) {
        result[i] += embedding[i] * normalizedWeight;
      }
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimensions; i++) {
        result[i] /= magnitude;
      }
    }

    return result;
  }
}

export const analysisVersionUpgradeWorker = new AnalysisVersionUpgradeWorker();
