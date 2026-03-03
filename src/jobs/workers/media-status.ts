/**
 * Media status worker.
 * Handles status updates from image providers (processing/completed/failed).
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documentMedia, media, nodeMedia } from '../../models/schema';
import { graphService } from '../../services/graph/graph.service';
import { sseService } from '../../services/sse';
import { logger } from '../../utils/logger';
import { jobService } from '../service';
import { JobWorker } from '../worker';
import type { Job, JobProgress, JobType } from '../types';

interface MediaStatusPayload {
  mediaId: string;
  status: 'processing' | 'completed' | 'failed';
  s3Key?: string;
  error?: string;
}

class MediaStatusWorker extends JobWorker<MediaStatusPayload, JobProgress> {
  protected jobType: JobType = 'media_status_update';

  constructor() {
    super('media-status-worker');
  }

  protected async processJob(job: Job, payload: MediaStatusPayload): Promise<void> {
    const { mediaId, status, s3Key, error } = payload;

    if (!mediaId) {
      logger.error({ jobId: job.id, payload }, 'Status update missing mediaId');
      return;
    }

    if (!status) {
      logger.error({ jobId: job.id, payload }, 'Status update missing status field');
      return;
    }

    logger.info({ jobId: job.id, mediaId, status }, 'Processing media status update');

    if (status === 'processing') {
      await db
        .update(media)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(media.id, mediaId));

      logger.info({ mediaId }, 'Updated media status to processing');
    } else if (status === 'completed') {
      if (!s3Key) {
        logger.error({ mediaId }, 'Completed status missing s3Key');
        return;
      }

      const [mediaRecord] = await db
        .select({ cancelledAt: media.cancelledAt })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (mediaRecord?.cancelledAt) {
        logger.info({ mediaId }, 'Ignoring completed message for cancelled job');
        return;
      }

      await db
        .update(media)
        .set({ status: 'completed', s3Key, updatedAt: new Date() })
        .where(eq(media.id, mediaId));

      logger.info({ mediaId, s3Key }, 'Updated media status to completed');

      // Queue thumbnail generation job
      await this.queueThumbnailJob(job.userId, mediaId);

      await this.autoSetPrimaryForCharacterSheet(mediaId);
    } else if (status === 'failed') {
      const [mediaRecord] = await db
        .select({ cancelledAt: media.cancelledAt })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (mediaRecord?.cancelledAt) {
        logger.info({ mediaId }, 'Ignoring failed message for cancelled job');
        return;
      }

      await db
        .update(media)
        .set({
          status: 'failed',
          error: error || 'Unknown error',
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId));

      logger.error({ mediaId, error }, 'Updated media status to failed');
    }

    await this.broadcastMediaUpdate(mediaId);
  }

  private async queueThumbnailJob(userId: string, mediaId: string): Promise<void> {
    try {
      await jobService.create({
        type: 'thumbnail_generation',
        targetType: 'media',
        targetId: mediaId,
        userId,
        payload: { mediaId },
      });
      logger.info({ mediaId }, 'Queued thumbnail generation job');
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to queue thumbnail job');
    }
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

      const nodeMed = await db
        .select({ nodeId: nodeMedia.nodeId })
        .from(nodeMedia)
        .where(eq(nodeMedia.mediaId, mediaId))
        .limit(1);

      if (nodeMed.length > 0) {
        const nodeId = nodeMed[0].nodeId;
        sseService.broadcastToNode(nodeId, 'node-media-update', { mediaId });
        logger.debug({ mediaId, nodeId }, 'Broadcasted node media update via SSE');
      }
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to broadcast media update');
    }
  }

  private async autoSetPrimaryForCharacterSheet(mediaId: string) {
    try {
      const [mediaRecord] = await db
        .select({ mediaRole: media.mediaRole })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (mediaRecord?.mediaRole !== 'character_sheet') {
        return;
      }

      const [nodeMed] = await db
        .select({ nodeId: nodeMedia.nodeId })
        .from(nodeMedia)
        .where(eq(nodeMedia.mediaId, mediaId))
        .limit(1);

      if (!nodeMed) {
        return;
      }

      const node = await graphService.getStoryNodeByIdInternal(nodeMed.nodeId);

      if (!node || node.primaryMediaId) {
        return;
      }

      await graphService.updateStoryNodePrimaryMedia(nodeMed.nodeId, mediaId);

      logger.info(
        { nodeId: nodeMed.nodeId, mediaId },
        'Auto-set first completed character sheet as primary',
      );
    } catch (error) {
      logger.error(
        { error, mediaId },
        'Failed to auto-set primary for character sheet',
      );
    }
  }
}

export const mediaStatusWorker = new MediaStatusWorker();
