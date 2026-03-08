import { generateDocx } from '../../services/export/docx';
import { mapExportError } from '../../services/export/utils/errorMapper';
import { s3 } from '../../services/s3';
import { logger } from '../../utils/logger';
import type {
  DocxExportPayload,
  DocxExportProgress,
  Job,
  JobType,
} from '../types';
import { JobWorker } from '../worker';

class DocxExportWorker extends JobWorker<
  DocxExportPayload,
  DocxExportProgress
> {
  protected jobType: JobType = 'docx_export';

  constructor() {
    super('docx-export-worker');
  }

  protected async processJob(
    job: Job,
    payload: DocxExportPayload,
  ): Promise<void> {
    const {
      documentId,
      html: providedHtml,
      styles,
      cssVariables,
      filename,
      format,
      orientation,
    } = payload;

    if (!filename) {
      logger.error(
        { jobId: job.id, payload },
        'DOCX export job missing required fields',
      );
      return;
    }

    logger.info(
      { jobId: job.id, filename, documentId },
      'Processing DOCX export',
    );

    try {
      if (!providedHtml) {
        throw new Error('No HTML content provided for export');
      }

      const html = providedHtml;
      const exportStyles = styles || '';

      await this.updateProgress(job.id, { stageName: 'generating' });

      const result = await generateDocx(
        html,
        exportStyles,
        {
          format: format || 'a4',
          orientation: orientation || 'portrait',
          cssVariables,
        },
        () => job.status === 'cancelled',
      );

      await this.updateProgress(job.id, { stageName: 'uploading' });

      const s3Key = `exports/${job.userId}/${job.id}/${filename}.docx`;
      await s3.uploadBuffer(result.buffer, s3Key, result.mimeType);

      const docxUrl = await s3.generateDownloadUrl(s3Key, 3600);

      await this.updateProgress(job.id, {
        stageName: 'completed',
        docxUrl,
      });

      logger.info(
        { jobId: job.id, filename, s3Key, size: result.buffer.length },
        'DOCX export completed',
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
        'DOCX export failed',
      );

      const userMessage = mapExportError(error as Error, 'docx');
      throw new Error(userMessage);
    }
  }
}

export const docxExportWorker = new DocxExportWorker();
