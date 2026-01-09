import { db } from '../config/database';
import { media, documentMedia } from '../models/schema';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { sseService } from './sse';

class GenerationQueueConsumer {
  private isRunning = false;
  private redisClient: Redis;

  constructor() {
    // Dedicated Redis client for queue operations - brpop() blocks the connection
    this.redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.redisClient.on('error', (error) => {
      logger.error({ error }, 'Generation queue consumer Redis error');
    });
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Generation queue consumer already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting generation queue consumer...');

    this.consumeProcessing();
    this.consumeCompleted();
    this.consumeFailed();

    logger.info('Generation queue consumer started successfully');
  }

  private async consumeProcessing() {
    while (this.isRunning) {
      try {
        const result = await this.redisClient.brpop('generation:processing', 1);
        if (!result) continue;

        const message = JSON.parse(result[1]);
        const { mediaId } = message;

        if (!mediaId) {
          logger.error({ message }, 'Processing queue message missing mediaId');
          continue;
        }

        await db
          .update(media)
          .set({ status: 'processing' })
          .where(eq(media.id, mediaId));

        logger.info({ mediaId }, 'Updated generation status to processing');
        await this.broadcastMediaUpdate(mediaId);
      } catch (error) {
        logger.error({ error }, 'Error processing "processing" queue');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async consumeCompleted() {
    while (this.isRunning) {
      try {
        logger.debug('Waiting for message from generation:completed queue...');
        const result = await this.redisClient.brpop('generation:completed', 1);

        if (!result) {
          logger.debug('No message in queue (timeout)');
          continue;
        }

        logger.info({ rawMessage: result[1] }, 'Received message from completed queue');
        const message = JSON.parse(result[1]);
        const { mediaId, s3Key } = message;

        if (!mediaId || !s3Key) {
          logger.error({ message }, 'Completed queue message missing required fields');
          continue;
        }

        // Check if job was cancelled - ignore if so
        const [job] = await db
          .select({ cancelledAt: media.cancelledAt })
          .from(media)
          .where(eq(media.id, mediaId))
          .limit(1);

        if (job?.cancelledAt) {
          logger.info({ mediaId }, 'Ignoring completed message for cancelled job');
          continue;
        }

        logger.info({ mediaId, s3Key }, 'Updating media status to completed');
        await db
          .update(media)
          .set({ status: 'completed', s3Key })
          .where(eq(media.id, mediaId));

        logger.info({ mediaId, s3Key }, 'Generation completed successfully');
        await this.broadcastMediaUpdate(mediaId);
      } catch (error) {
        logger.error({ error }, 'Error processing "completed" queue');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async consumeFailed() {
    while (this.isRunning) {
      try {
        const result = await this.redisClient.brpop('generation:failed', 1);
        if (!result) continue;

        const message = JSON.parse(result[1]);
        const { mediaId, error } = message;

        if (!mediaId) {
          logger.error({ message }, 'Failed queue message missing mediaId');
          continue;
        }

        // Check if job was cancelled - ignore if so
        const [job] = await db
          .select({ cancelledAt: media.cancelledAt })
          .from(media)
          .where(eq(media.id, mediaId))
          .limit(1);

        if (job?.cancelledAt) {
          logger.info({ mediaId }, 'Ignoring failed message for cancelled job');
          continue;
        }

        await db
          .update(media)
          .set({ status: 'failed', error: error || 'Unknown error' })
          .where(eq(media.id, mediaId));

        logger.error({ mediaId, error }, 'Generation failed');
        await this.broadcastMediaUpdate(mediaId);
      } catch (err) {
        logger.error({ error: err }, 'Error processing "failed" queue');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
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

    logger.info('Stopping generation queue consumer...');
    this.isRunning = false;
    await this.redisClient.quit();
    logger.info('Generation queue consumer stopped');
  }
}

export const generationQueueConsumer = new GenerationQueueConsumer();
