import { documentsService } from '../../services/documents';
import { generateDocx } from '../../services/export/docx';
import { DEFAULT_EXPORT_STYLES } from '../../services/export/utils/defaultStyles';
import { documentToHtml } from '../../services/export/utils/documentToHtml';
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

    let html: string;

    try {
      const document = await documentsService.getById(documentId);

      if (document.contentJson) {
        logger.info({ jobId: job.id }, 'Generating HTML from contentJson');
        html = documentToHtml(document.contentJson);
      } else if (providedHtml) {
        logger.warn(
          { jobId: job.id, htmlLength: providedHtml.length },
          'Using provided HTML (contentJson not available)',
        );
        html = providedHtml;
      } else {
        throw new Error(
          'No content available for export (missing contentJson and html)',
        );
      }

      logger.info(
        {
          jobId: job.id,
          htmlLength: html.length,
          htmlPreview: html.substring(0, 500),
        },
        'HTML prepared for DOCX generation',
      );

      const exportStyles = styles || DEFAULT_EXPORT_STYLES;

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
