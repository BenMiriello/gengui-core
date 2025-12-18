import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import mediaRoutes from './routes/media';
import tagRoutes from './routes/tags';
import generationsRoutes from './routes/generations';
import documentsRoutes from './routes/documents';

export function createApp() {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'http:', 'https:'],
          upgradeInsecureRequests: null,
        },
      },
    })
  );

  app.use(
    cors({
      origin: env.NODE_ENV === 'development' ? ['http://localhost:5173', 'http://localhost:3001'] : [],
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use(express.static('public'));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((req, _res, next) => {
    logger.info({ method: req.method, path: req.path }, 'Request');
    next();
  });

  app.use('/api', authRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/generations', generationsRoutes);
  app.use('/api', tagRoutes);
  app.use('/api', documentsRoutes);

  app.use(errorHandler);

  return app;
}
