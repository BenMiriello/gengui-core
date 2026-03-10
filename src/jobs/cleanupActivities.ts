import cron from 'node-cron';
import { activityService } from '../services/activity.service';
import { logger } from '../utils/logger';

/**
 * Starts a daily cron job to clean up old activities (older than 30 days).
 * Runs at 3:00 AM daily.
 */
export function startCleanupActivitiesJob(): cron.ScheduledTask {
  const task = cron.schedule(
    '0 3 * * *',
    async () => {
      logger.info('Starting activities cleanup job');

      try {
        const deletedCount = await activityService.cleanup();
        logger.info({ deletedCount }, 'Activities cleanup completed');
      } catch (error) {
        logger.error({ error }, 'Activities cleanup failed');
      }
    },
    {
      timezone: 'UTC',
    },
  );

  logger.info('Activities cleanup cron job scheduled (daily at 3:00 AM UTC)');

  return task;
}
