import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { jobStatusConsumer } from './services/jobStatusConsumer';
import { jobReconciliationService } from './services/runpod';
import { textAnalysisConsumer } from './services/textAnalysisConsumer';
import { promptAugmentationService } from './services/prompt-augmentation';
import { startReconciliationJob } from './jobs/reconcileGenerations';
import { startCleanupJob } from './jobs/cleanupSoftDeleted';
import { redis } from './services/redis';
import { closeDatabase } from './config/database';
import type { ScheduledTask } from 'node-cron';
import blocked from 'blocked-at';

// Monitor event loop blocking
blocked((time, stack) => {
  logger.warn({ time, stack: stack.slice(0, 5) }, `[EVENT LOOP BLOCKED] for ${time}ms`);
}, { threshold: 100 });

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

  // Force exit after 5s if graceful shutdown hangs
  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000);

  try {
    // Stop cron jobs first
    if (reconciliationTask) reconciliationTask.stop();
    if (cleanupTask) cleanupTask.stop();

    // Stop consumers
    await jobStatusConsumer.stop();
    await jobReconciliationService.stop();
    textAnalysisConsumer.stop();
    promptAugmentationService.stop();

    // Close connections
    await redis.disconnect();
    await closeDatabase();

    server.close(() => {
      clearTimeout(forceExit);
      logger.info('Server closed');
      process.exit(0);
    });
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
