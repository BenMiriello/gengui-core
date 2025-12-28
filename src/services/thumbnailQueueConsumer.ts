import { redis } from './redis';
import { logger } from '../utils/logger';
import { thumbnailProcessor } from './thumbnailProcessor';

class ThumbnailQueueConsumer {
  private isRunning = false;

  async start() {
    if (this.isRunning) {
      logger.warn('Thumbnail queue consumer already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting thumbnail queue consumer...');

    this.consume();

    logger.info('Thumbnail queue consumer started successfully');
  }

  private async consume() {
    while (this.isRunning) {
      try {
        const result = await redis.brpop('thumbnail:queue', 1);

        if (!result) {
          continue;
        }

        const mediaId = result[1];

        if (!mediaId) {
          logger.error({ message: result[1] }, 'Thumbnail queue message invalid');
          continue;
        }

        logger.info({ mediaId }, 'Processing thumbnail generation');
        await thumbnailProcessor.processThumbnail(mediaId);

      } catch (error) {
        logger.error({ error }, 'Error processing thumbnail queue');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping thumbnail queue consumer...');
    this.isRunning = false;
    logger.info('Thumbnail queue consumer stopped');
  }
}

export const thumbnailQueueConsumer = new ThumbnailQueueConsumer();
