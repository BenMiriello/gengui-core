import cron from 'node-cron';
import { customStylePromptsService } from '../services/customStylePrompts';
import { logger } from '../utils/logger';

const CLEANUP_JOB_SCHEDULE = '0 2 * * *';

export function startCleanupJob() {
  cron.schedule(CLEANUP_JOB_SCHEDULE, async () => {
    try {
      const count = await customStylePromptsService.cleanupDeleted();

      if (count > 0) {
        logger.info({ count }, 'Soft delete cleanup job completed');
      }
    } catch (error) {
      logger.error({ error }, 'Soft delete cleanup job failed');
    }
  });

  logger.info('Soft delete cleanup job scheduled (runs daily at 2 AM)');
}
