// Run with: `npx tsx backfill-thumbnails.ts`

import { db } from '../config/database';
import { media } from '../models/schema';
import { and, isNull } from 'drizzle-orm';
import { notDeleted } from '../utils/db';
import { redisStreams } from '../services/redis-streams';
import { logger } from '../utils/logger';

async function backfillThumbnails() {
  try {
    logger.info('Starting thumbnail backfill...');

    const mediaItems = await db
      .select({ id: media.id, mimeType: media.mimeType, s3Key: media.s3Key, storageKey: media.storageKey })
      .from(media)
      .where(and(
        isNull(media.s3KeyThumb),
        notDeleted(media.deletedAt)
      ));

    logger.info({ count: mediaItems.length }, 'Found media items without thumbnails');

    let queued = 0;
    for (const item of mediaItems) {
      if ((item.s3Key || item.storageKey) && (item.mimeType?.startsWith('image/') || item.mimeType === null)) {
        await redisStreams.add('thumbnail:stream', { mediaId: item.id });
        queued++;
      }
    }

    logger.info({ total: mediaItems.length, queued }, 'Thumbnail backfill completed');
    logger.info('Monitor progress with: redis-cli XLEN thumbnail:stream');

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Failed to backfill thumbnails');
    process.exit(1);
  }
}

backfillThumbnails();
