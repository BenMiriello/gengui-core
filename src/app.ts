import express from 'express';
import { logger } from './middleware/logger';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(logger);

  app.use('/api', healthRouter);

  app.use(errorHandler);

  return app;
}
