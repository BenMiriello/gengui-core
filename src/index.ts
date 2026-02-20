import blocked from 'blocked-at';
import type { ScheduledTask } from 'node-cron';
import { createApp } from './app';
import { closeDatabase } from './config/database';
import { env } from './config/env';
import { startCleanupJob } from './jobs/cleanupSoftDeleted';
import { startReconciliationJob } from './jobs/reconcileGenerations';
import { graphService } from './services/graph/graph.service';
import { jobStatusConsumer } from './services/jobStatusConsumer';
import { promptAugmentationService } from './services/prompt-augmentation';
import { redis } from './services/redis';
import { jobReconciliationService } from './services/runpod';
import { sseService } from './services/sse';
import { textAnalysisConsumer } from './services/textAnalysisConsumer';
import { logger } from './utils/logger';

blocked(
  (time, stack) => {
    logger.warn(
      { time, stack: stack.slice(0, 5) },
      `[EVENT LOOP BLOCKED] for ${time}ms`,
    );
  },
  { threshold: 100 },
);

const app = createApp();

let reconciliationTask: ScheduledTask;
let cleanupTask: ScheduledTask;

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);

  try {
    await jobStatusConsumer.start();
    await jobReconciliationService.start();
    await textAnalysisConsumer.start();
    await promptAugmentationService.start();
    reconciliationTask = startReconciliationJob();
    cleanupTask = startCleanupJob();

    await graphService.initializeIndexes();
  } catch (error) {
    logger.error({ error }, 'Failed to start generation services');
  }
});

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, forcing immediate exit');
    process.exit(1);
  }
  isShuttingDown = true;

  logger.info(`${signal} received, shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000);

  try {
    if (reconciliationTask) reconciliationTask.stop();
    if (cleanupTask) cleanupTask.stop();

    await Promise.all([
      jobStatusConsumer.stop(),
      jobReconciliationService.stop(),
      textAnalysisConsumer.stop(),
      promptAugmentationService.stop(),
    ]);

    sseService.closeAll();

    await redis.disconnect();

    await graphService.disconnect();

    await closeDatabase();

    await new Promise<void>((resolve) => {
      const closeTimeout = setTimeout(() => {
        logger.warn('Server close timed out, continuing shutdown');
        resolve();
      }, 3000);

      server.close(() => {
        clearTimeout(closeTimeout);
        resolve();
      });
    });

    clearTimeout(forceExit);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    clearTimeout(forceExit);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
