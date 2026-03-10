import { db } from '../../config/database';
import { documents } from '../../models/schema';
import { logger } from '../../utils/logger';
import { activityService } from '../activity.service';
import type { ActivityProgress } from '../activity.types';
import { segmentService } from '../segments';
import { GoogleDriveClient } from './client';
import { DriveConnectionExpiredError, mapDriveErrorToMessage } from './errors';
import { clearTokens, getValidAccessToken } from './tokens';
import type { DriveFile } from './types';

const SUPPORTED_MIME_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'text/plain',
  'text/markdown',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;

interface DriveImportOptions {
  userId: string;
  fileId: string;
}

interface DriveImportResult {
  documentId: string;
  title: string;
}

export async function importFromDrive(
  options: DriveImportOptions,
): Promise<DriveImportResult> {
  const { userId, fileId } = options;

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    throw new DriveConnectionExpiredError();
  }

  const client = new GoogleDriveClient(accessToken);

  let metadata: DriveFile;
  try {
    metadata = await client.getFileMetadata(fileId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('401')) {
      await clearTokens(userId);
      throw new DriveConnectionExpiredError();
    }
    throw error;
  }

  if (!SUPPORTED_MIME_TYPES.includes(metadata.mimeType)) {
    throw new Error(
      `Unsupported file type: ${metadata.mimeType}. Supported formats: Google Docs, DOCX, PDF, TXT, MD.`,
    );
  }

  if (metadata.size && Number(metadata.size) > MAX_FILE_SIZE) {
    throw new Error('File exceeds size limit (10MB max).');
  }

  const activity = await activityService.create({
    userId,
    activityType: 'drive_import',
    targetType: 'document',
    targetId: '00000000-0000-0000-0000-000000000000',
    title: `Importing: ${metadata.name}`,
    viewedAt: new Date(),
  });

  try {
    await activityService.updateProgress(activity.id, {
      stage: 1,
      totalStages: 3,
      stageName: 'downloading',
    } as ActivityProgress);

    let content: ArrayBuffer;
    let mimeType: string;

    if (metadata.mimeType === 'application/vnd.google-apps.document') {
      content = await client.exportGoogleDoc(fileId, 'text/html');
      mimeType = 'text/html';
    } else {
      content = await client.downloadFile(fileId);
      mimeType = metadata.mimeType;
    }

    await activityService.updateProgress(activity.id, {
      stage: 2,
      totalStages: 3,
      stageName: 'converting',
    } as ActivityProgress);

    const converted = await convertToEditorFormat(
      content,
      mimeType,
      metadata.name,
    );

    await activityService.updateProgress(activity.id, {
      stage: 3,
      totalStages: 3,
      stageName: 'creating',
    } as ActivityProgress);

    const segments = segmentService.computeSegments(converted.plainText);

    const [document] = await db
      .insert(documents)
      .values({
        userId,
        title: converted.title,
        content: converted.plainText,
        yjsState: converted.yjsState,
        segmentSequence: segments,
      })
      .returning();

    await activityService.updateStatus(activity.id, 'completed');

    logger.info(
      {
        userId,
        documentId: document.id,
        driveFileId: fileId,
        filename: metadata.name,
      },
      'Document imported from Google Drive',
    );

    return { documentId: document.id, title: document.title };
  } catch (error) {
    const errorMessage = mapDriveErrorToMessage(error);
    await activityService.updateStatus(activity.id, 'failed', {
      errorMessage,
    });

    logger.error(
      { userId, fileId, error },
      'Failed to import from Google Drive',
    );
    throw new Error(errorMessage);
  }
}

interface ConvertedContent {
  title: string;
  plainText: string;
  yjsState: string;
}

async function convertToEditorFormat(
  content: ArrayBuffer,
  mimeType: string,
  filename: string,
): Promise<ConvertedContent> {
  const title = filename.replace(/\.[^/.]+$/, '');
  const buffer = Buffer.from(content);

  switch (mimeType) {
    case 'text/html': {
      const htmlText = buffer.toString('utf-8');
      const { plainText, yjsState } = htmlToYjsState(htmlText);
      return { title, plainText, yjsState };
    }

    case 'text/plain': {
      const text = buffer.toString('utf-8');
      const { plainText, yjsState } = textToYjsState(text);
      return { title, plainText, yjsState };
    }

    case 'text/markdown': {
      const mdText = buffer.toString('utf-8');
      const { plainText, yjsState } = markdownToYjsState(mdText);
      return { title, plainText, yjsState };
    }

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const { plainText, yjsState } = await docxToYjsState(buffer);
      return { title, plainText, yjsState };
    }

    case 'application/pdf': {
      const { plainText, yjsState } = await pdfToYjsState(buffer);
      return { title, plainText, yjsState };
    }

    default:
      throw new Error(`Unsupported mime type: ${mimeType}`);
  }
}

function htmlToYjsState(html: string): { plainText: string; yjsState: string } {
  const plainText = extractTextFromHtml(html);
  const doc = createYjsDocFromText(plainText);
  return { plainText, yjsState: doc };
}

function textToYjsState(text: string): { plainText: string; yjsState: string } {
  const doc = createYjsDocFromText(text);
  return { plainText: text, yjsState: doc };
}

function markdownToYjsState(md: string): {
  plainText: string;
  yjsState: string;
} {
  const plainText = md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const doc = createYjsDocFromText(plainText);
  return { plainText, yjsState: doc };
}

async function docxToYjsState(
  buffer: Buffer,
): Promise<{ plainText: string; yjsState: string }> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const plainText = result.value;
    const doc = createYjsDocFromText(plainText);
    return { plainText, yjsState: doc };
  } catch {
    throw new Error('Failed to parse DOCX file');
  }
}

async function pdfToYjsState(
  buffer: Buffer,
): Promise<{ plainText: string; yjsState: string }> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    const plainText = data.text;
    const doc = createYjsDocFromText(plainText);
    return { plainText, yjsState: doc };
  } catch {
    throw new Error('Failed to parse PDF file');
  }
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function createYjsDocFromText(text: string): string {
  const Y = require('yjs');
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('prosemirror');

  // Create a minimal ProseMirror-compatible doc structure
  const docNode = new Y.XmlElement('doc');

  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const xmlElement = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    xmlText.insert(0, para.trim());
    xmlElement.insert(0, [xmlText]);
    docNode.push([xmlElement]);
  }

  // If no paragraphs, add an empty one
  if (docNode.length === 0) {
    const emptyPara = new Y.XmlElement('paragraph');
    docNode.push([emptyPara]);
  }

  xmlFragment.push([docNode]);

  const state = Y.encodeStateAsUpdate(doc);
  return Buffer.from(state).toString('base64');
}
