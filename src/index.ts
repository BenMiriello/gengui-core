import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { generationListener } from './services/generationListener';

const app = createApp();

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);

  try {
    await generationListener.start();
  } catch (error) {
    logger.error({ error }, 'Failed to start generation listener');
  }
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await generationListener.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await generationListener.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
