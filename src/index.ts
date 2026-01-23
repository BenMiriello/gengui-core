import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { jobStatusConsumer } from './services/jobStatusConsumer';
import { jobReconciliationService } from './services/runpod';
import { textAnalysisConsumer } from './services/textAnalysisConsumer';
import { promptAugmentationService } from './services/prompt-augmentation';
import { startReconciliationJob } from './jobs/reconcileGenerations';
import { startCleanupJob } from './jobs/cleanupSoftDeleted';
import blocked from 'blocked-at';

// Monitor event loop blocking (log if blocked > 100ms)
blocked((time, stack) => {
  logger.warn({ time, stack: stack.slice(0, 5) }, `[EVENT LOOP BLOCKED] for ${time}ms`);
}, { threshold: 100 });

const app = createApp();

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);

  try {
    await jobStatusConsumer.start();
    await jobReconciliationService.start();
    await textAnalysisConsumer.start();
    await promptAugmentationService.start();
    startReconciliationJob();
    startCleanupJob();
  } catch (error) {
    logger.error({ error }, 'Failed to start generation services');
  }
});

const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);

  // Force exit after 5s if graceful shutdown hangs
  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000);

  try {
    await jobStatusConsumer.stop();
    await jobReconciliationService.stop();
    textAnalysisConsumer.stop();
    promptAugmentationService.stop();
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
