import { db } from '../config/database';
import { media, documentMedia } from '../models/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { sseService } from './sse';
import { BlockingConsumer } from '../lib/blocking-consumer';
import type { StreamMessage } from './redis-streams';

class GenerationQueueConsumer extends BlockingConsumer {
  constructor() {
    super('generation-queue-consumer');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce('generation:processing:stream', 'core-processors');
    await this.streams.ensureGroupOnce('generation:completed:stream', 'core-completers');
    await this.streams.ensureGroupOnce('generation:failed:stream', 'core-failers');
  }

  protected consumeLoop() {
    // Start three concurrent consumer loops
    this.consumeProcessing();
    this.consumeCompleted();
    this.consumeFailed();
  }

  private async consumeProcessing() {
    const streamName = 'generation:processing:stream';
    const groupName = 'core-processors';
    const consumerName = `core-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(streamName, groupName, consumerName, {
          block: 10000
        });

        if (!result) continue;

        const { id, data } = result;
        const { mediaId } = data;

        if (!mediaId) {
          logger.error({ data }, 'Processing stream message missing mediaId');
          await this.streams.ack(streamName, groupName, id);
          continue;
        }

        await db
          .update(media)
          .set({ status: 'processing', updatedAt: new Date() })
          .where(eq(media.id, mediaId));

        logger.info({ mediaId }, 'Updated generation status to processing');
        await this.broadcastMediaUpdate(mediaId);
        await this.streams.ack(streamName, groupName, id);
      } catch (error) {
        logger.error({ error }, 'Error processing "processing" stream');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async consumeCompleted() {
    const streamName = 'generation:completed:stream';
    const groupName = 'core-completers';
    const consumerName = `core-completer-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(streamName, groupName, consumerName, {
          block: 10000
        });

        if (!result) continue;

        const { id, data } = result;
        const { mediaId, s3Key } = data;

        if (!mediaId || !s3Key) {
          logger.error({ data }, 'Completed stream message missing required fields');
          await this.streams.ack(streamName, groupName, id);
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
          await this.streams.ack(streamName, groupName, id);
          continue;
        }

        logger.info({ mediaId, s3Key }, 'Updating media status to completed');
        await db
          .update(media)
          .set({ status: 'completed', s3Key, updatedAt: new Date() })
          .where(eq(media.id, mediaId));

        logger.info({ mediaId, s3Key }, 'Generation completed successfully');
        await this.broadcastMediaUpdate(mediaId);
        await this.streams.ack(streamName, groupName, id);
      } catch (error) {
        logger.error({ error }, 'Error processing "completed" stream');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async consumeFailed() {
    const streamName = 'generation:failed:stream';
    const groupName = 'core-failers';
    const consumerName = `core-failer-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(streamName, groupName, consumerName, {
          block: 10000
        });

        if (!result) continue;

        const { id, data } = result;
        const { mediaId, error } = data;

        if (!mediaId) {
          logger.error({ data }, 'Failed stream message missing mediaId');
          await this.streams.ack(streamName, groupName, id);
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
          await this.streams.ack(streamName, groupName, id);
          continue;
        }

        await db
          .update(media)
          .set({ status: 'failed', error: error || 'Unknown error', updatedAt: new Date() })
          .where(eq(media.id, mediaId));

        logger.error({ mediaId, error }, 'Generation failed');
        await this.broadcastMediaUpdate(mediaId);
        await this.streams.ack(streamName, groupName, id);
      } catch (err) {
        logger.error({ error: err }, 'Error processing "failed" stream');
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
}

export const generationQueueConsumer = new GenerationQueueConsumer();
