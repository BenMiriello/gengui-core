import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database';
import { jobService } from '../jobs/service';
import type { DocxExportProgress, PdfExportProgress } from '../jobs/types';
import { requireAuth } from '../middleware/auth';
import { jobs } from '../models/schema';
import { documentsService } from '../services/documents';
import { logger } from '../utils/logger';

const router = Router();

const MAX_HTML_SIZE = 10 * 1024 * 1024;
const MAX_STYLES_SIZE = 1 * 1024 * 1024;

const ExportFormatSchema = z.enum(['pdf', 'docx'] as const);

const ExportRequestSchema = z.object({
  html: z.string().max(MAX_HTML_SIZE, 'HTML too large (max 10MB)').optional(),
  styles: z
    .string()
    .max(MAX_STYLES_SIZE, 'Styles too large (max 1MB)')
    .optional(),
  cssVariables: z.record(z.string(), z.string()).optional(),
  filename: z.string().min(1).max(255),
  format: z.enum(['a4', 'letter']).default('a4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
});

router.post(
  '/documents/:id/export/:format',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id, format: formatParam } = req.params;

      // Validate format
      const formatResult = ExportFormatSchema.safeParse(formatParam);
      if (!formatResult.success) {
        res.status(400).json({
          error: {
            message: `Invalid format. Must be one of: ${ExportFormatSchema.options.join(', ')}`,
            code: 'INVALID_FORMAT',
          },
        });
        return;
      }

      const format = formatResult.data;

      // Validate request body
      const bodyResult = ExportRequestSchema.safeParse(req.body);
      if (!bodyResult.success) {
        const firstError = bodyResult.error.issues[0];
        res.status(400).json({
          error: {
            message: firstError?.message || 'Invalid request body',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const { html, styles, cssVariables, filename } = bodyResult.data;

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

      // Create job based on format
      const jobType = format === 'pdf' ? 'pdf_export' : 'docx_export';

      const payload = {
        documentId: id,
        html,
        styles,
        filename: sanitizedFilename,
        format: bodyResult.data.format,
        orientation: bodyResult.data.orientation,
        ...(format === 'docx' && cssVariables ? { cssVariables } : {}),
      };

      const job = await jobService.create({
        type: jobType,
        targetType: 'document',
        targetId: id,
        userId,
        payload,
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
        { jobId: job.id, documentId: id, userId, format },
        `${format.toUpperCase()} export job created`,
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
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
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
        const progress = job.progress as PdfExportProgress | DocxExportProgress;
        const downloadUrl =
          (progress as PdfExportProgress)?.pdfUrl ||
          (progress as DocxExportProgress)?.docxUrl;

        res.json({
          status: 'completed',
          downloadUrl,
          pdfUrl: (progress as PdfExportProgress)?.pdfUrl,
          docxUrl: (progress as DocxExportProgress)?.docxUrl,
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
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
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
