import { BlockingConsumer } from '../lib/blocking-consumer';
import { logger } from '../utils/logger';
import { thumbnailProcessor } from './thumbnailProcessor';

class ThumbnailQueueConsumer extends BlockingConsumer {
  constructor() {
    super('thumbnail-queue-consumer');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce(
      'thumbnail:stream',
      'thumbnail-processors',
    );
  }

  protected async consumeLoop() {
    const streamName = 'thumbnail:stream';
    const groupName = 'thumbnail-processors';
    const consumerName = `thumbnail-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(
          streamName,
          groupName,
          consumerName,
          {
            block: 2000,
          },
        );

        if (!result) continue;

        const { id, data } = result;
        const { mediaId } = data;

        if (!mediaId) {
          logger.error({ data }, 'Thumbnail stream message missing mediaId');
          await this.streams.ack(streamName, groupName, id);
          continue;
        }

        logger.info({ mediaId }, 'Processing thumbnail generation');
        try {
          await thumbnailProcessor.processThumbnail(mediaId);
          await this.streams.ack(streamName, groupName, id);
          logger.info({ mediaId }, 'Thumbnail completed and ACKed');
        } catch (error) {
          logger.error({ error, mediaId }, 'Thumbnail failed, will retry');
        }
      } catch (error) {
        logger.error({ error }, 'Error processing thumbnail stream');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

export const thumbnailQueueConsumer = new ThumbnailQueueConsumer();
