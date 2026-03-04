/**
 * Thumbnail generation worker.
 * Generates thumbnails for completed media.
 */

import { thumbnailProcessor } from '../../services/thumbnailProcessor';
import { logger } from '../../utils/logger';
import type { Job, JobProgress, JobType } from '../types';
import { JobWorker } from '../worker';

interface ThumbnailPayload {
  mediaId: string;
}

class ThumbnailWorker extends JobWorker<ThumbnailPayload, JobProgress> {
  protected jobType: JobType = 'thumbnail_generation';

  constructor() {
    super('thumbnail-worker');
  }

  protected async processJob(
    job: Job,
    payload: ThumbnailPayload,
  ): Promise<void> {
    const { mediaId } = payload;

    if (!mediaId) {
      logger.error({ jobId: job.id, payload }, 'Thumbnail job missing mediaId');
      return;
    }

    logger.info({ jobId: job.id, mediaId }, 'Processing thumbnail generation');

    await thumbnailProcessor.processThumbnail(mediaId);

    logger.info({ jobId: job.id, mediaId }, 'Thumbnail generation completed');
  }
}

export const thumbnailWorker = new ThumbnailWorker();
