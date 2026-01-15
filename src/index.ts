import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { jobStatusConsumer } from './services/jobStatusConsumer';
import { jobReconciliationService } from './services/runpod';
import { textAnalysisService } from './services/textAnalysisService';
import { promptAugmentationService } from './services/promptAugmentationService';
import { startReconciliationJob } from './jobs/reconcileGenerations';
import { startCleanupJob } from './jobs/cleanupSoftDeleted';

const app = createApp();

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);

  try {
    await jobStatusConsumer.start();
    await jobReconciliationService.start();
    await textAnalysisService.start();
    await promptAugmentationService.start();
    startReconciliationJob();
    startCleanupJob();
  } catch (error) {
    logger.error({ error }, 'Failed to start generation services');
  }
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await jobStatusConsumer.stop();
  await jobReconciliationService.stop();
  textAnalysisService.stop();
  promptAugmentationService.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await jobStatusConsumer.stop();
  await jobReconciliationService.stop();
  textAnalysisService.stop();
  promptAugmentationService.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
