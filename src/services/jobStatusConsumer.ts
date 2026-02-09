import { eq } from 'drizzle-orm';
import { db } from '../config/database';
import { BlockingConsumer } from '../lib/blocking-consumer';
import { documentMedia, media, nodeMedia } from '../models/schema';
import { logger } from '../utils/logger';
import { graphService } from './graph/graph.service';
import { type StreamMessage, redisStreams as sharedRedisStreams } from './redis-streams';
import { sseService } from './sse';
import { thumbnailProcessor } from './thumbnailProcessor';

class JobStatusConsumer extends BlockingConsumer {
  constructor() {
    super('job-status-consumer');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce('job:status:stream', 'core-status-processors');
    await this.streams.ensureGroupOnce('thumbnail:stream', 'thumbnail-processors');
  }

  protected async consumeLoop(): Promise<void> {
    const consumerName = `status-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        // Read from streams sequentially with short block times for faster shutdown
        const statusResult = await this.streams.consume(
          'job:status:stream',
          'core-status-processors',
          consumerName,
          {
            block: 1000,
            count: 1,
          }
        );

        if (!this.isRunning) break;

        const thumbnailResult = await this.streams.consume(
          'thumbnail:stream',
          'thumbnail-processors',
          consumerName,
          {
            block: 1000,
            count: 1,
          }
        );

        // Process status updates
        if (statusResult) {
          try {
            await this.handleStatusUpdate(
              'job:status:stream',
              'core-status-processors',
              statusResult
            );
          } catch (error) {
            logger.error({ error, messageId: statusResult.id }, 'Error processing status update');
            // Still ACK to avoid reprocessing bad messages
            await this.streams.ack('job:status:stream', 'core-status-processors', statusResult.id);
          }
        }

        // Process thumbnail requests
        if (thumbnailResult) {
          try {
            await this.handleThumbnail('thumbnail:stream', 'thumbnail-processors', thumbnailResult);
          } catch (error) {
            logger.error({ error, messageId: thumbnailResult.id }, 'Error processing thumbnail');
            // Still ACK to avoid reprocessing bad messages
            await this.streams.ack('thumbnail:stream', 'thumbnail-processors', thumbnailResult.id);
          }
        }
      } catch (error: any) {
        // Shutdown in progress - exit gracefully
        if (!this.isRunning) break;

        // Redis disconnected during shutdown
        if (error?.message?.includes('Connection') || error?.code === 'ERR_CONNECTION_CLOSED') {
          break;
        }

        logger.error({ error }, 'Error in job status consumer loop');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleStatusUpdate(streamName: string, groupName: string, message: StreamMessage) {
    const { status, mediaId, s3Key, error } = message.data;

    if (!mediaId) {
      logger.error({ data: message.data }, 'Status update missing mediaId');
      await this.streams.ack(streamName, groupName, message.id);
      return;
    }

    if (!status) {
      logger.error({ data: message.data }, 'Status update missing status field');
      await this.streams.ack(streamName, groupName, message.id);
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
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      // Check if job was cancelled
      const [job] = await db
        .select({ cancelledAt: media.cancelledAt })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (job?.cancelledAt) {
        logger.info({ mediaId }, 'Ignoring completed message for cancelled job');
        await this.streams.ack(streamName, groupName, message.id);
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
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      await db
        .update(media)
        .set({ status: 'failed', error: error || 'Unknown error', updatedAt: new Date() })
        .where(eq(media.id, mediaId));

      logger.error({ mediaId, error }, 'Updated media status to failed');
    }

    // Broadcast SSE update
    await this.broadcastMediaUpdate(mediaId);

    // ACK message
    await this.streams.ack(streamName, groupName, message.id);
  }

  private async handleThumbnail(streamName: string, groupName: string, message: StreamMessage) {
    const { mediaId } = message.data;

    if (!mediaId) {
      logger.error({ data: message.data }, 'Thumbnail message missing mediaId');
      await this.streams.ack(streamName, groupName, message.id);
      return;
    }

    logger.info({ mediaId }, 'Processing thumbnail generation');
    try {
      await thumbnailProcessor.processThumbnail(mediaId);
      await this.streams.ack(streamName, groupName, message.id);
      logger.info({ mediaId }, 'Thumbnail completed and ACKed');
    } catch (error) {
      logger.error({ error, mediaId }, 'Thumbnail failed, will retry');
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
        logger.debug({ mediaId, documentId }, 'Broadcasted media update via SSE');
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
        logger.debug({ mediaId, nodeId }, 'Broadcasted node media update via SSE');
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
        'Auto-set first completed character sheet as primary'
      );
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to auto-set primary for character sheet');
    }
  }
}

export const jobStatusConsumer = new JobStatusConsumer();
