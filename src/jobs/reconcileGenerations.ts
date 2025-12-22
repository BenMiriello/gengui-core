import cron from 'node-cron';
import { db } from '../config/database';
import { media } from '../models/schema';
import { and, inArray, lt, eq } from 'drizzle-orm';
import { redis } from '../services/redis';
import { logger } from '../utils/logger';

export function startReconciliationJob() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      const stuckMedia = await db
        .select({ id: media.id })
        .from(media)
        .where(
          and(
            inArray(media.status, ['queued', 'processing']),
            lt(media.createdAt, tenMinutesAgo)
          )
        );

      if (stuckMedia.length === 0) {
        return;
      }

      let recovered = 0;

      for (const { id } of stuckMedia) {
        const job = await redis.getJob(id);
        if (!job) continue;

        if (job.status === 'completed' && job.s3Key) {
          await db.update(media)
            .set({ status: 'completed', s3Key: job.s3Key })
            .where(eq(media.id, id));
          recovered++;
          logger.info({ mediaId: id }, 'Reconciliation recovered completed generation');
        } else if (job.status === 'failed') {
          await db.update(media)
            .set({ status: 'failed', error: job.error || 'Unknown error' })
            .where(eq(media.id, id));
          recovered++;
          logger.info({ mediaId: id }, 'Reconciliation recovered failed generation');
        }
      }

      if (recovered > 0) {
        logger.info({ recovered, total: stuckMedia.length }, 'Reconciliation job recovered stuck generations');
      }
    } catch (error) {
      logger.error({ error }, 'Reconciliation job failed');
    }
  });

  logger.info('Reconciliation job scheduled (runs every 5 minutes)');
}
