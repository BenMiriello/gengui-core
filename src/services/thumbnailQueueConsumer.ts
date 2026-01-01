import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { thumbnailProcessor } from './thumbnailProcessor';

class ThumbnailQueueConsumer {
  private isRunning = false;
  private redisClient: Redis;

  constructor() {
    // Dedicated Redis client for queue operations - brpop() blocks the connection
    this.redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.redisClient.on('error', (error) => {
      logger.error({ error }, 'Thumbnail queue consumer Redis error');
    });
  }

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
        const result = await this.redisClient.brpop('thumbnail:queue', 1);

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
    await this.redisClient.quit();
    logger.info('Thumbnail queue consumer stopped');
  }
}

export const thumbnailQueueConsumer = new ThumbnailQueueConsumer();
