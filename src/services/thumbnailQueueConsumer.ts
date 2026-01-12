import { logger } from '../utils/logger';
import { thumbnailProcessor } from './thumbnailProcessor';
import { redisStreams } from './redis-streams';

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
    const streamName = 'thumbnail:stream';
    const groupName = 'thumbnail-processors';
    const consumerName = `thumbnail-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await redisStreams.consume(streamName, groupName, consumerName, {
          block: 10000
        });

        if (!result) continue;

        const { id, data } = result;
        const { mediaId } = data;

        if (!mediaId) {
          logger.error({ data }, 'Thumbnail stream message missing mediaId');
          await redisStreams.ack(streamName, groupName, id);
          continue;
        }

        logger.info({ mediaId }, 'Processing thumbnail generation');
        await thumbnailProcessor.processThumbnail(mediaId);
        await redisStreams.ack(streamName, groupName, id);

      } catch (error) {
        logger.error({ error }, 'Error processing thumbnail stream');
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
