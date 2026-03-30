import * as Sentry from '@sentry/node';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { passport } from './config/passport';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { activitiesRouter } from './routes/activities';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import conflictsRoutes from './routes/conflicts';
import contactRoutes from './routes/contact';
import customStylePromptsRoutes from './routes/customStylePrompts';
import documentsRoutes from './routes/documents';
import earlyAccessRoutes from './routes/earlyAccess';
import { exportRouter } from './routes/export';
import generationsRoutes from './routes/generations';
import googleDriveRoutes from './routes/google-drive';
import mediaRoutes from './routes/media';
import nodesRoutes from './routes/nodes';
import { sseRouter } from './routes/sse';
import tagRoutes from './routes/tags';
// Logging configured via middleware

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
          upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        },
      },
    }),
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
    }),
  );

  // Large document support - default 100KB is too small for narrative documents
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser(env.COOKIE_SECRET || 'dev-secret'));
  app.use(passport.initialize());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (env.NODE_ENV !== 'production') {
    app.get('/health/config', (_req, res) => {
      res.json({
        geminiConfigured: !!env.GEMINI_API_KEY,
        redisConfigured: !!process.env.REDIS_URL,
        s3Configured: !!(process.env.AWS_ACCESS_KEY_ID || env.MINIO_ACCESS_KEY),
        s3Bucket: process.env.S3_BUCKET || env.MINIO_BUCKET,
        frontendUrl: env.FRONTEND_URL,
        nodeEnv: env.NODE_ENV,
        imageProvider: env.IMAGE_INFERENCE_PROVIDER,
      });
    });
  }

  // Request logging with requestId correlation
  app.use((req, res, next) => {
    const isHeartbeat = req.path.includes('/heartbeat');
    const isMediaUrl = req.path.match(/\/api\/media\/[^/]+\/url$/);
    const isHealthCheck = req.path === '/health';

    if (!isHeartbeat && !isMediaUrl && !isHealthCheck) {
      requestLogger(req, res, next);
    } else {
      next();
    }
  });

  app.use('/api', authRoutes);
  app.use('/api', conflictsRoutes);
  app.use('/api', contactRoutes);
  app.use('/api', earlyAccessRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/generations', generationsRoutes);
  app.use('/api', tagRoutes);
  app.use('/api', documentsRoutes);
  app.use('/api', customStylePromptsRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', nodesRoutes);
  app.use('/api', exportRouter);
  app.use('/api', googleDriveRoutes);
  app.use('/api', activitiesRouter);
  app.use('', sseRouter); // Unified SSE endpoints at /sse/*

  Sentry.setupExpressErrorHandler(app);
  app.use(errorHandler);

  return app;
}
