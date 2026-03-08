import type { BrowserContext } from 'puppeteer';
import { generatePdf } from '../../services/export/pdf';
import { mapExportError } from '../../services/export/utils/errorMapper';
import { puppeteerPool } from '../../services/puppeteerPool';
import { s3 } from '../../services/s3';
import { logger } from '../../utils/logger';
import type {
  Job,
  JobType,
  PdfExportPayload,
  PdfExportProgress,
} from '../types';
import { JobWorker } from '../worker';

class PdfExportWorker extends JobWorker<PdfExportPayload, PdfExportProgress> {
  protected jobType: JobType = 'pdf_export';

  constructor() {
    super('pdf-export-worker');
  }

  protected async processJob(
    job: Job,
    payload: PdfExportPayload,
  ): Promise<void> {
    const {
      documentId,
      html: providedHtml,
      styles,
      filename,
      format,
      orientation,
    } = payload;

    if (!filename) {
      logger.error(
        { jobId: job.id, payload },
        'PDF export job missing required fields',
      );
      return;
    }

    logger.info(
      { jobId: job.id, filename, documentId },
      'Processing PDF export',
    );

    let context: BrowserContext | null = null;

    try {
      if (!providedHtml) {
        throw new Error('No HTML content provided for export');
      }

      const html = providedHtml;
      const exportStyles = styles || '';

      await this.updateProgress(job.id, { stageName: 'rendering' });

      context = await puppeteerPool.acquire();
      const page = await context.newPage();

      const result = await generatePdf(
        page,
        html,
        exportStyles,
        { format: format || 'a4', orientation: orientation || 'portrait' },
        () => job.status === 'cancelled',
      );

      await page.close();

      await this.updateProgress(job.id, { stageName: 'uploading' });

      const s3Key = `exports/${job.userId}/${job.id}/${filename}.pdf`;
      await s3.uploadBuffer(result.buffer, s3Key, result.mimeType);

      const pdfUrl = await s3.generateDownloadUrl(s3Key, 3600);

      await this.updateProgress(job.id, {
        stageName: 'completed',
        pdfUrl,
      });

      logger.info(
        { jobId: job.id, filename, s3Key, size: result.buffer.length },
        'PDF export completed',
      );
    } catch (error) {
      logger.error(
        {
          error,
          jobId: job.id,
          filename,
          errorType: (error as Error).name,
          errorMessage: (error as Error).message,
          stack: (error as Error).stack,
        },
        'PDF export failed',
      );

      const userMessage = mapExportError(error as Error, 'pdf');
      throw new Error(userMessage);
    } finally {
      if (context) {
        await puppeteerPool.release(context);
      }
    }
  }
}

export const pdfExportWorker = new PdfExportWorker();
