import type { BrowserContext } from 'puppeteer';
import { generatePdf } from '../../services/pdfGenerator';
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
    const { html, styles, filename, format, orientation } = payload;

    if (!html || !styles || !filename) {
      logger.error(
        { jobId: job.id, payload },
        'PDF export job missing required fields',
      );
      return;
    }

    logger.info({ jobId: job.id, filename }, 'Processing PDF export');

    let context: BrowserContext | null = null;

    try {
      await this.updateProgress(job.id, { stageName: 'rendering' });

      context = await puppeteerPool.acquire();

      const pdfBuffer = await generatePdf(
        context,
        html,
        styles,
        { format, orientation },
        () => job.status === 'cancelled',
      );

      await this.updateProgress(job.id, { stageName: 'uploading' });

      const s3Key = `exports/${job.userId}/${job.id}/${filename}.pdf`;
      await s3.uploadBuffer(pdfBuffer, s3Key, 'application/pdf');

      const pdfUrl = await s3.generateDownloadUrl(s3Key, 3600);

      await this.updateProgress(job.id, {
        stageName: 'completed',
        pdfUrl,
      });

      logger.info(
        { jobId: job.id, filename, s3Key, size: pdfBuffer.length },
        'PDF export completed',
      );
    } catch (error) {
      logger.error({ error, jobId: job.id, filename }, 'PDF export failed');
      throw error;
    } finally {
      if (context) {
        await puppeteerPool.release(context);
      }
    }
  }
}

export const pdfExportWorker = new PdfExportWorker();
