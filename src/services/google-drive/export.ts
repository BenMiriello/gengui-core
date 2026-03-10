import { logger } from '../../utils/logger';
import { activityService } from '../activity.service';
import type { ActivityProgress } from '../activity.types';
import { documentsService } from '../documents';
import { generateDocx } from '../export/docx';
import { generatePdf } from '../export/pdf';
import { puppeteerPool } from '../puppeteerPool';
import { GoogleDriveClient } from './client';
import { DriveConnectionExpiredError, mapDriveErrorToMessage } from './errors';
import { clearTokens, getValidAccessToken } from './tokens';
import type { DriveFile } from './types';

interface DriveExportOptions {
  userId: string;
  documentId: string;
  folderId: string | null;
  format: 'pdf' | 'docx';
  filename: string;
  html: string;
  styles?: string;
}

interface DriveExportResult {
  driveFileId: string;
  webViewLink: string;
}

async function uploadWithErrorHandling(
  client: GoogleDriveClient,
  userId: string,
  folderId: string | null,
  fullFilename: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<DriveFile> {
  try {
    return await client.uploadFile(
      folderId,
      fullFilename,
      fileBuffer,
      mimeType,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('401')) {
      await clearTokens(userId);
      throw new DriveConnectionExpiredError();
    }
    throw error;
  }
}

export async function exportToDrive(
  options: DriveExportOptions,
): Promise<DriveExportResult> {
  const { userId, documentId, folderId, format, filename, html, styles } =
    options;

  // Verify document exists and user has access
  await documentsService.get(documentId, userId);

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    throw new DriveConnectionExpiredError();
  }

  const activity = await activityService.create({
    userId,
    activityType: 'drive_export',
    targetType: 'document',
    targetId: documentId,
    title: `Exporting to Drive: ${filename}.${format}`,
    viewedAt: new Date(),
  });

  try {
    await activityService.updateProgress(activity.id, {
      stage: 1,
      totalStages: 3,
      stageName: 'generating',
    } as ActivityProgress);

    let fileBuffer: Buffer;
    let mimeType: string;

    if (format === 'pdf') {
      const context = await puppeteerPool.acquire();
      try {
        const page = await context.newPage();
        const result = await generatePdf(page, html, styles || '', {
          format: 'a4',
          orientation: 'portrait',
        });
        await page.close();
        fileBuffer = result.buffer;
        mimeType = result.mimeType;
      } finally {
        await puppeteerPool.release(context);
      }
    } else {
      const result = await generateDocx(html);
      fileBuffer = result.buffer;
      mimeType = result.mimeType;
    }

    await activityService.updateProgress(activity.id, {
      stage: 2,
      totalStages: 3,
      stageName: 'uploading',
    } as ActivityProgress);

    const client = new GoogleDriveClient(accessToken);
    const fullFilename = `${filename}.${format}`;

    const driveFile = await uploadWithErrorHandling(
      client,
      userId,
      folderId,
      fullFilename,
      fileBuffer,
      mimeType,
    );

    await activityService.updateStatus(activity.id, 'completed', {
      resultUrl: driveFile.webViewLink || undefined,
    });

    logger.info(
      {
        userId,
        documentId,
        driveFileId: driveFile.id,
        filename: fullFilename,
        format,
      },
      'Document exported to Google Drive',
    );

    return {
      driveFileId: driveFile.id,
      webViewLink: driveFile.webViewLink || '',
    };
  } catch (error) {
    const errorMessage = mapDriveErrorToMessage(error);
    await activityService.updateStatus(activity.id, 'failed', {
      errorMessage,
    });

    logger.error(
      { userId, documentId, error },
      'Failed to export to Google Drive',
    );
    throw new Error(errorMessage);
  }
}
