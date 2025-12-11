import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import mediaRoutes from './routes/media';

export function createApp() {
  const app = express();

  app.use(helmet());

  app.use(
    cors({
      origin: env.NODE_ENV === 'development' ? '*' : [],
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, 'Request');
    next();
  });

  app.use('/api/media', mediaRoutes);

  app.use(errorHandler);

  return app;
}
