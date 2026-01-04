import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { generationListener } from './services/generationListener';
import { generationQueueConsumer } from './services/generationQueueConsumer';
import { thumbnailQueueConsumer } from './services/thumbnailQueueConsumer';
import { startReconciliationJob } from './jobs/reconcileGenerations';
import { startCleanupJob } from './jobs/cleanupSoftDeleted';

const app = createApp();

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);

  try {
    await generationListener.start();
    await generationQueueConsumer.start();
    await thumbnailQueueConsumer.start();
    startReconciliationJob();
    startCleanupJob();
  } catch (error) {
    logger.error({ error }, 'Failed to start generation services');
  }
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await generationListener.stop();
  await generationQueueConsumer.stop();
  await thumbnailQueueConsumer.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await generationListener.stop();
  await generationQueueConsumer.stop();
  await thumbnailQueueConsumer.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
