import timeout from 'connect-timeout';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { documentsService } from '../services/documents';
import { generateDocx } from '../services/export/docx';
import { generatePdf } from '../services/export/pdf';
import { puppeteerPool } from '../services/puppeteerPool';
import { logger } from '../utils/logger';

const router = Router();

router.use(timeout('90s'));

const MAX_HTML_SIZE = 10 * 1024 * 1024;
const MAX_STYLES_SIZE = 1 * 1024 * 1024;

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
  '/documents/:id/export/pdf/download',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;

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

      const { html, styles, filename, format, orientation } = bodyResult.data;

      const document = await documentsService.get(id, userId);
      if (!document) {
        res.status(404).json({
          error: { message: 'Document not found', code: 'NOT_FOUND' },
        });
        return;
      }

      if (!html) {
        res.status(400).json({
          error: { message: 'HTML content required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const sanitizedFilename = filename
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .substring(0, 100);

      logger.info(
        { documentId: id, userId, filename: sanitizedFilename },
        'Processing PDF export',
      );

      const context = await puppeteerPool.acquire();
      try {
        const page = await context.newPage();
        const result = await generatePdf(page, html, styles || '', {
          format: format || 'a4',
          orientation: orientation || 'portrait',
        });
        await page.close();

        res.setHeader('Content-Type', result.mimeType);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${sanitizedFilename}.pdf"`,
        );
        res.send(result.buffer);

        logger.info(
          { documentId: id, size: result.buffer.length },
          'PDF export completed',
        );
      } finally {
        await puppeteerPool.release(context);
      }
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/export/docx/download',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { id } = req.params;

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

      const { html, filename } = bodyResult.data;

      const document = await documentsService.get(id, userId);
      if (!document) {
        res.status(404).json({
          error: { message: 'Document not found', code: 'NOT_FOUND' },
        });
        return;
      }

      if (!html) {
        res.status(400).json({
          error: { message: 'HTML content required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const sanitizedFilename = filename
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .substring(0, 100);

      logger.info(
        { documentId: id, userId, filename: sanitizedFilename },
        'Processing DOCX export',
      );

      const result = await generateDocx(html);

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${sanitizedFilename}.docx"`,
      );
      res.send(result.buffer);

      logger.info(
        { documentId: id, size: result.buffer.length },
        'DOCX export completed',
      );
    } catch (error) {
      next(error);
    }
  },
);

export { router as exportRouter };
