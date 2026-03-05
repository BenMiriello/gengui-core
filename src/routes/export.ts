import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { db } from '../config/database';
import { jobService } from '../jobs/service';
import type { PdfExportProgress } from '../jobs/types';
import { requireAuth } from '../middleware/auth';
import { jobs } from '../models/schema';
import { documentsService } from '../services/documents';
import { logger } from '../utils/logger';

const router = Router();

const MAX_HTML_SIZE = 10 * 1024 * 1024;

router.post(
  '/documents/:id/export/pdf',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Express Request type augmentation
      const userId = (req as any).user.id;
      const { id } = req.params;
      const { html, styles, filename } = req.body;

      if (!html || !styles || !filename) {
        res.status(400).json({
          error: {
            message: 'html, styles, and filename are required',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      if (html.length > MAX_HTML_SIZE) {
        res.status(400).json({
          error: {
            message: 'HTML content exceeds maximum size (10MB)',
            code: 'CONTENT_TOO_LARGE',
          },
        });
        return;
      }

      const document = await documentsService.get(id, userId);

      if (!document) {
        res.status(404).json({
          error: { message: 'Document not found', code: 'NOT_FOUND' },
        });
        return;
      }

      const sanitizedFilename = filename
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .substring(0, 100);

      const job = await jobService.create({
        type: 'pdf_export',
        targetType: 'document',
        targetId: id,
        userId,
        payload: {
          documentId: id,
          html,
          styles,
          filename: sanitizedFilename,
          format: req.body.format || 'a4',
          orientation: req.body.orientation || 'portrait',
        },
      });

      if (!job) {
        res.status(500).json({
          error: {
            message: 'Failed to create export job',
            code: 'JOB_CREATION_FAILED',
          },
        });
        return;
      }

      logger.info(
        { jobId: job.id, documentId: id, userId },
        'PDF export job created',
      );

      res.json({ jobId: job.id, status: 'queued' });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/export/jobs/:jobId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Express Request type augmentation
      const userId = (req as any).user.id;
      const { jobId } = req.params;

      const [job] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);

      if (!job) {
        res.status(404).json({
          error: { message: 'Job not found', code: 'NOT_FOUND' },
        });
        return;
      }

      if (job.userId !== userId) {
        res.status(403).json({
          error: { message: 'Forbidden', code: 'FORBIDDEN' },
        });
        return;
      }

      if (job.status === 'completed') {
        const progress = job.progress as PdfExportProgress;
        res.json({
          status: 'completed',
          pdfUrl: progress?.pdfUrl,
        });
      } else if (job.status === 'failed') {
        res.json({
          status: 'failed',
          error: job.errorMessage,
        });
      } else {
        res.json({
          status: 'processing',
          progress: job.progress,
        });
      }
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/export/jobs/:jobId/cancel',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Express Request type augmentation
      const userId = (req as any).user.id;
      const { jobId } = req.params;

      const [job] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);

      if (!job) {
        res.status(404).json({
          error: { message: 'Job not found', code: 'NOT_FOUND' },
        });
        return;
      }

      if (job.userId !== userId) {
        res.status(403).json({
          error: { message: 'Forbidden', code: 'FORBIDDEN' },
        });
        return;
      }

      if (
        job.status === 'completed' ||
        job.status === 'failed' ||
        job.status === 'cancelled'
      ) {
        res.json({ success: true, message: 'Job already finished' });
        return;
      }

      await jobService.updateStatus(jobId, 'cancelled');

      logger.info({ jobId, userId }, 'Export job cancelled by user');

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

export { router as exportRouter };
