import { eq } from 'drizzle-orm';
import { db } from '../config/database';
import { MultiStreamPubSubConsumer } from '../lib/pubsub-consumer';
import { documentMedia, media, nodeMedia } from '../models/schema';
import { logger } from '../utils/logger';
import { graphService } from './graph/graph.service';
import {
  type StreamMessage,
  redisStreams as sharedRedisStreams,
} from './redis-streams';
import { sseService } from './sse';
import { thumbnailProcessor } from './thumbnailProcessor';

class JobStatusConsumer extends MultiStreamPubSubConsumer {
  protected streamConfigs = [
    {
      streamName: 'job:status:stream',
      groupName: 'core-status-processors',
      consumerName: `status-processor-${process.pid}`,
    },
    {
      streamName: 'thumbnail:stream',
      groupName: 'thumbnail-processors',
      consumerName: `thumbnail-processor-${process.pid}`,
    },
  ];

  constructor() {
    super('job-status-consumer');
  }

  protected async handleMessage(
    streamName: string,
    _groupName: string,
    message: StreamMessage,
  ) {
    if (streamName === 'job:status:stream') {
      await this.handleStatusUpdate(message);
    } else if (streamName === 'thumbnail:stream') {
      await this.handleThumbnail(message);
    }
  }

  private async handleStatusUpdate(message: StreamMessage) {
    const { status, mediaId, s3Key, error } = message.data;

    if (!mediaId) {
      logger.error({ data: message.data }, 'Status update missing mediaId');
      return;
    }

    if (!status) {
      logger.error(
        { data: message.data },
        'Status update missing status field',
      );
      return;
    }

    logger.info({ mediaId, status }, 'Processing status update');

    // Update DB based on status
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

      // Check if job was cancelled
      const [job] = await db
        .select({ cancelledAt: media.cancelledAt })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (job?.cancelledAt) {
        logger.info(
          { mediaId },
          'Ignoring completed message for cancelled job',
        );
        return;
      }

      await db
        .update(media)
        .set({ status: 'completed', s3Key, updatedAt: new Date() })
        .where(eq(media.id, mediaId));

      logger.info({ mediaId, s3Key }, 'Updated media status to completed');

      // Queue thumbnail generation (use shared client for producer operations)
      await sharedRedisStreams.add('thumbnail:stream', { mediaId });

      // Auto-set primary for character sheets if node has no primary
      await this.autoSetPrimaryForCharacterSheet(mediaId);
    } else if (status === 'failed') {
      // Check if job was cancelled
      const [job] = await db
        .select({ cancelledAt: media.cancelledAt })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (job?.cancelledAt) {
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

    // Broadcast SSE update
    await this.broadcastMediaUpdate(mediaId);
  }

  private async handleThumbnail(message: StreamMessage) {
    const { mediaId } = message.data;

    if (!mediaId) {
      logger.error({ data: message.data }, 'Thumbnail message missing mediaId');
      return;
    }

    logger.info({ mediaId }, 'Processing thumbnail generation');
    try {
      await thumbnailProcessor.processThumbnail(mediaId);
      logger.info({ mediaId }, 'Thumbnail completed');
    } catch (error) {
      logger.error({ error, mediaId }, 'Thumbnail failed');
      throw error; // Re-throw to prevent ACK, allowing retry
    }
  }

  private async broadcastMediaUpdate(mediaId: string) {
    try {
      // Broadcast to document if this media belongs to a document
      const docMedia = await db
        .select({ documentId: documentMedia.documentId })
        .from(documentMedia)
        .where(eq(documentMedia.mediaId, mediaId))
        .limit(1);

      if (docMedia.length > 0) {
        const documentId = docMedia[0].documentId;
        sseService.broadcastToDocument(documentId, 'media-update', { mediaId });
        logger.debug(
          { mediaId, documentId },
          'Broadcasted media update via SSE',
        );
      }

      // Broadcast to node if this media belongs to a node (character sheet)
      const nodeMed = await db
        .select({ nodeId: nodeMedia.nodeId })
        .from(nodeMedia)
        .where(eq(nodeMedia.mediaId, mediaId))
        .limit(1);

      if (nodeMed.length > 0) {
        const nodeId = nodeMed[0].nodeId;
        sseService.broadcastToNode(nodeId, 'node-media-update', { mediaId });
        logger.debug(
          { mediaId, nodeId },
          'Broadcasted node media update via SSE',
        );
      }
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to broadcast media update');
    }
  }

  /**
   * Auto-set primary media for character sheet if the node has no primary.
   */
  private async autoSetPrimaryForCharacterSheet(mediaId: string) {
    try {
      // Check if this is a character sheet
      const [mediaRecord] = await db
        .select({ mediaRole: media.mediaRole })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (mediaRecord?.mediaRole !== 'character_sheet') {
        return;
      }

      // Find the associated node
      const [nodeMed] = await db
        .select({ nodeId: nodeMedia.nodeId })
        .from(nodeMedia)
        .where(eq(nodeMedia.mediaId, mediaId))
        .limit(1);

      if (!nodeMed) {
        return;
      }

      // Check if node has no primary media (from FalkorDB)
      const node = await graphService.getStoryNodeByIdInternal(nodeMed.nodeId);

      if (!node || node.primaryMediaId) {
        return;
      }

      // Set this media as primary in FalkorDB
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

export const jobStatusConsumer = new JobStatusConsumer();
