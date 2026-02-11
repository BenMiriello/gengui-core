import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import customStylePromptsRoutes from './routes/customStylePrompts';
import documentsRoutes from './routes/documents';
import generationsRoutes from './routes/generations';
import mediaRoutes from './routes/media';
import nodesRoutes from './routes/nodes';
import tagRoutes from './routes/tags';
import { logger } from './utils/logger';

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

  const corsOrigins =
    env.NODE_ENV === 'development'
      ? ['http://localhost:5173', 'http://localhost:3001']
      : env.FRONTEND_URL
        ? [env.FRONTEND_URL]
        : [];

  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/config', (_req, res) => {
    res.json({
      geminiConfigured: !!process.env.GEMINI_API_KEY,
      redisConfigured: !!process.env.REDIS_URL,
      s3Configured: !!(process.env.AWS_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY),
      s3Bucket: process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'media',
      frontendUrl: process.env.FRONTEND_URL || 'not set',
      nodeEnv: process.env.NODE_ENV,
      imageProvider: process.env.IMAGE_INFERENCE_PROVIDER || 'gemini',
    });
  });

  app.use((req, _res, next) => {
    // Skip logging for high-frequency endpoints
    const isHeartbeat = req.path.includes('/heartbeat');
    const isMediaUrl = req.path.match(/\/api\/media\/[^/]+\/url$/);
    const isHealthCheck = req.path === '/health';

    if (!isHeartbeat && !isMediaUrl && !isHealthCheck) {
      logger.info({ method: req.method, path: req.path }, 'Request');
    }
    next();
  });

  app.use('/api', authRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/generations', generationsRoutes);
  app.use('/api', tagRoutes);
  app.use('/api', documentsRoutes);
  app.use('/api', customStylePromptsRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', nodesRoutes);

  app.use(errorHandler);

  return app;
}
