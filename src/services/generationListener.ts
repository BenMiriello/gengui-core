import { db } from '../config/database';
import { documentMedia } from '../models/schema';
import { eq } from 'drizzle-orm';
import { redis } from './redis';
import { redisStreams } from './redis-streams';
import { logger } from '../utils/logger';
import { sseService } from './sse';

class GenerationListener {
  private isListening = false;

  async start() {
    if (this.isListening) {
      logger.warn('Generation listener already running');
      return;
    }

    this.isListening = true;
    logger.info('Starting generation listener...');

    try {
      // Use dedicated subscriber client to avoid blocking shared client
      const subscriber = redis.getSubscriber();
      await subscriber.psubscribe('generation:*');

      subscriber.on('pmessage', async (pattern, channel, message) => {
        try {
          const data = JSON.parse(message);
          await this.handleGenerationEvent(channel, data);
        } catch (error) {
          logger.error({ error, channel, message }, 'Failed to process generation event');
        }
      });

      logger.info('Generation listener started successfully');
    } catch (error) {
      this.isListening = false;
      logger.error({ error }, 'Failed to start generation listener');
      throw error;
    }
  }

  private async handleGenerationEvent(channel: string, data: any) {
    const { mediaId } = data;

    if (!mediaId) {
      logger.error({ channel, data }, 'Generation event missing mediaId');
      return;
    }

    if (channel === 'generation:complete') {
      await this.handleComplete(mediaId, data);
    } else if (channel === 'generation:failed') {
      await this.handleFailed(mediaId, data);
    } else if (channel === 'generation:processing') {
      await this.handleProcessing(mediaId);
    }
  }

  private async handleProcessing(mediaId: string) {
    try {
      await this.broadcastMediaUpdate(mediaId);
      logger.debug({ mediaId }, 'Broadcasted processing notification via SSE');
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to broadcast processing notification');
    }
  }

  private async handleComplete(mediaId: string, data: { s3Key: string }) {
    try {
      await redisStreams.add('thumbnail:stream', { mediaId });
      await this.broadcastMediaUpdate(mediaId);
      logger.debug({ mediaId }, 'Broadcasted completion notification via SSE and queued thumbnail generation');
    } catch (error) {
      logger.error({ error, mediaId, data }, 'Failed to broadcast completion notification');
    }
  }

  private async handleFailed(mediaId: string, data: { error: string }) {
    try {
      await this.broadcastMediaUpdate(mediaId);
      logger.debug({ mediaId }, 'Broadcasted failure notification via SSE');
    } catch (err) {
      logger.error({ error: err, mediaId, data }, 'Failed to broadcast failure notification');
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
    if (!this.isListening) {
      return;
    }

    logger.info('Stopping generation listener...');
    this.isListening = false;
    // Note: Subscriber client cleanup is handled by RedisService shutdown
    logger.info('Generation listener stopped');
  }
}

export const generationListener = new GenerationListener();
