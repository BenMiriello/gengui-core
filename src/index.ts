import blocked from 'blocked-at';
import type { ScheduledTask } from 'node-cron';
import { createApp } from './app';
import { closeDatabase } from './config/database';
import { env } from './config/env';
import { startCleanupReservationsJob } from './jobs/cleanupReservations';
import { startCleanupJob } from './jobs/cleanupSoftDeleted';
import { startJobWorkers, stopJobWorkers } from './jobs/index';
import { startReconciliationJob } from './jobs/reconcileGenerations';
import { cpuPool } from './lib/cpu-pool';
import { graphService } from './services/graph/graph.service';
import { puppeteerPool } from './services/puppeteerPool';
import { redis } from './services/redis';
import { jobReconciliationService } from './services/runpod';
import { sseService } from './services/sse';
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
let cleanupReservationsTask: { stop: () => void };

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);

  try {
    await jobReconciliationService.start();
    await startJobWorkers();
    reconciliationTask = startReconciliationJob();
    cleanupTask = startCleanupJob();
    cleanupReservationsTask = startCleanupReservationsJob();

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
    if (cleanupReservationsTask) cleanupReservationsTask.stop();

    await cpuPool.shutdown();

    await Promise.all([jobReconciliationService.stop(), stopJobWorkers()]);

    await puppeteerPool.shutdown();

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
