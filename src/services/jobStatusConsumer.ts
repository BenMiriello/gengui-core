import { db } from '../config/database';
import { media, documentMedia } from '../models/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { sseService } from './sse';
import { redisStreams, StreamMessage } from './redis-streams';
import { thumbnailProcessor } from './thumbnailProcessor';

class JobStatusConsumer {
  private isRunning = false;

  async start() {
    if (this.isRunning) {
      logger.warn('Job status consumer already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting unified job status consumer...');

    // Create consumer groups once at startup
    await redisStreams.ensureGroupOnce('job:status:stream', 'core-status-processors');
    await redisStreams.ensureGroupOnce('thumbnail:stream', 'thumbnail-processors');

    this.consumeMessages();

    logger.info('Job status consumer started successfully');
  }

  private async consumeMessages() {
    const consumerName = `status-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        // Read from both streams in parallel (different consumer groups)
        const [statusResult, thumbnailResult] = await Promise.all([
          redisStreams.consume('job:status:stream', 'core-status-processors', consumerName, {
            block: 2000,
            count: 1,
          }),
          redisStreams.consume('thumbnail:stream', 'thumbnail-processors', consumerName, {
            block: 2000,
            count: 1,
          }),
        ]);

        // Process status updates
        if (statusResult) {
          try {
            await this.handleStatusUpdate('job:status:stream', 'core-status-processors', statusResult);
          } catch (error) {
            logger.error({ error, messageId: statusResult.id }, 'Error processing status update');
            // Still ACK to avoid reprocessing bad messages
            await redisStreams.ack('job:status:stream', 'core-status-processors', statusResult.id);
          }
        }

        // Process thumbnail requests
        if (thumbnailResult) {
          try {
            await this.handleThumbnail('thumbnail:stream', 'thumbnail-processors', thumbnailResult);
          } catch (error) {
            logger.error({ error, messageId: thumbnailResult.id }, 'Error processing thumbnail');
            // Still ACK to avoid reprocessing bad messages
            await redisStreams.ack('thumbnail:stream', 'thumbnail-processors', thumbnailResult.id);
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error in job status consumer loop');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleStatusUpdate(
    streamName: string,
    groupName: string,
    message: StreamMessage
  ) {
    const { status, mediaId, s3Key, error } = message.data;

    if (!mediaId) {
      logger.error({ data: message.data }, 'Status update missing mediaId');
      await redisStreams.ack(streamName, groupName, message.id);
      return;
    }

    if (!status) {
      logger.error({ data: message.data }, 'Status update missing status field');
      await redisStreams.ack(streamName, groupName, message.id);
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
        await redisStreams.ack(streamName, groupName, message.id);
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
        await redisStreams.ack(streamName, groupName, message.id);
        return;
      }

      await db
        .update(media)
        .set({ status: 'completed', s3Key, updatedAt: new Date() })
        .where(eq(media.id, mediaId));

      logger.info({ mediaId, s3Key }, 'Updated media status to completed');

      // Queue thumbnail generation
      await redisStreams.add('thumbnail:stream', { mediaId });
    } else if (status === 'failed') {
      // Check if job was cancelled
      const [job] = await db
        .select({ cancelledAt: media.cancelledAt })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (job?.cancelledAt) {
        logger.info({ mediaId }, 'Ignoring failed message for cancelled job');
        await redisStreams.ack(streamName, groupName, message.id);
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
    await redisStreams.ack(streamName, groupName, message.id);
  }

  private async handleThumbnail(
    streamName: string,
    groupName: string,
    message: StreamMessage
  ) {
    const { mediaId } = message.data;

    if (!mediaId) {
      logger.error({ data: message.data }, 'Thumbnail message missing mediaId');
      await redisStreams.ack(streamName, groupName, message.id);
      return;
    }

    logger.info({ mediaId }, 'Processing thumbnail generation');
    try {
      await thumbnailProcessor.processThumbnail(mediaId);
      await redisStreams.ack(streamName, groupName, message.id);
      logger.info({ mediaId }, 'Thumbnail completed and ACKed');
    } catch (error) {
      logger.error({ error, mediaId }, 'Thumbnail failed, will retry');
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
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to broadcast media update');
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping job status consumer...');
    this.isRunning = false;
    logger.info('Job status consumer stopped');
  }
}

export const jobStatusConsumer = new JobStatusConsumer();
