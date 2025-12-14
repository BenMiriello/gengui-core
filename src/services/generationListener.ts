import { db } from '../config/database';
import { media } from '../models/schema';
import { eq } from 'drizzle-orm';
import { redis } from './redis';
import { logger } from '../utils/logger';

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
      await redis.subscribe('generation:*', async (channel, message) => {
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
      await db
        .update(media)
        .set({ status: 'processing' })
        .where(eq(media.id, mediaId));

      logger.info({ mediaId }, 'Updated generation status to processing');
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to update generation to processing');
    }
  }

  private async handleComplete(mediaId: string, data: { s3Key: string }) {
    try {
      const { s3Key } = data;

      if (!s3Key) {
        throw new Error('Missing s3Key in completion event');
      }

      await db
        .update(media)
        .set({
          status: 'completed',
          s3Key,
        })
        .where(eq(media.id, mediaId));

      logger.info({ mediaId, s3Key }, 'Generation completed successfully');
    } catch (error) {
      logger.error({ error, mediaId, data }, 'Failed to process completion event');
    }
  }

  private async handleFailed(mediaId: string, data: { error: string }) {
    try {
      const { error } = data;

      await db
        .update(media)
        .set({
          status: 'failed',
          error: error || 'Unknown error',
        })
        .where(eq(media.id, mediaId));

      logger.error({ mediaId, error }, 'Generation failed');
    } catch (err) {
      logger.error({ error: err, mediaId, data }, 'Failed to process failure event');
    }
  }

  async stop() {
    if (!this.isListening) {
      return;
    }

    logger.info('Stopping generation listener...');
    await redis.disconnect();
    this.isListening = false;
    logger.info('Generation listener stopped');
  }
}

export const generationListener = new GenerationListener();
