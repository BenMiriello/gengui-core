import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents, users } from '../../models/schema';
import { logger } from '../../utils/logger';
import type { Segment } from '../segments/segment.types';
import { validateSegmentsForContent } from '../segments/segment.validation';
import { storageProvider } from '../storage';

const PAGE_SEPARATOR = '\n\n';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export interface PdfImportResult {
  documentId: string;
  title: string;
  pageCount: number;
}

/**
 * Extract text from each page of a PDF buffer.
 * Returns an array of strings, one per page, preserving order.
 * Empty pages are included as empty strings to keep page numbers accurate.
 */
async function extractPageTexts(buffer: Buffer): Promise<string[]> {
  const pdfParse = (await import('pdf-parse')).default;
  const pageTexts: string[] = [];

  await pdfParse(buffer, {
    pagerender: async (pageData: {
      getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
    }) => {
      const textContent = await pageData.getTextContent();
      const text = textContent.items
        .map((item) => item.str)
        .join(' ')
        .trim();
      pageTexts.push(text);
      // Return empty string so pdf-parse's own text accumulation is suppressed
      return '';
    },
  });

  return pageTexts;
}

/**
 * Build page-based segments from extracted page texts.
 * Each page becomes one segment with a stable UUID.
 * Segments are separated by PAGE_SEPARATOR in the content string.
 */
function buildPageSegments(pageTexts: string[]): {
  content: string;
  segments: Segment[];
} {
  const segments: Segment[] = [];
  const parts: string[] = [];
  let offset = 0;

  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i];
    if (i > 0) {
      offset += PAGE_SEPARATOR.length;
    }

    if (text.length > 0) {
      segments.push({
        id: randomUUID(),
        start: offset,
        end: offset + text.length,
        page: i + 1,
      });
    }

    parts.push(text);
    offset += text.length;
  }

  return { content: parts.join(PAGE_SEPARATOR), segments };
}

/**
 * Import a PDF buffer as a native PDF document.
 * Stores the original file in S3 and creates a document record with
 * extracted text and page-based segments for the analysis pipeline.
 */
export async function importPdfDocument(
  userId: string,
  buffer: Buffer,
  filename: string,
): Promise<PdfImportResult> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(
      `PDF exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`,
    );
  }

  const documentId = randomUUID();
  const title = filename.replace(/\.pdf$/i, '').trim() || 'Imported Document';

  // Upload original PDF to S3
  const fileKey = `users/${userId}/documents/${documentId}.pdf`;
  await storageProvider.uploadFile(fileKey, buffer, 'application/pdf');
  logger.info({ documentId, fileKey }, 'PDF file uploaded to S3');

  // Extract text per page
  let pageTexts: string[];
  try {
    pageTexts = await extractPageTexts(buffer);
  } catch (err) {
    // Clean up the uploaded file before throwing
    await storageProvider.delete(fileKey).catch(() => {});
    throw new Error(
      `Failed to extract text from PDF: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  if (pageTexts.length === 0) {
    await storageProvider.delete(fileKey).catch(() => {});
    throw new Error('PDF appears to be empty or could not be parsed');
  }

  const { content, segments } = buildPageSegments(pageTexts);

  const validation = validateSegmentsForContent(segments, content.length);
  if (!validation.valid) {
    logger.error(
      { errors: validation.errors },
      'PDF segment validation failed',
    );
    await storageProvider.delete(fileKey).catch(() => {});
    throw new Error('Failed to build valid segments from PDF content');
  }

  // Fetch user defaults for image dimensions
  const [user] = await db
    .select({
      defaultImageWidth: users.defaultImageWidth,
      defaultImageHeight: users.defaultImageHeight,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const [document] = await db
    .insert(documents)
    .values({
      id: documentId,
      userId,
      title,
      content,
      documentType: 'pdf',
      fileKey,
      pageCount: pageTexts.length,
      segmentSequence: segments,
      defaultImageWidth: user?.defaultImageWidth ?? 1024,
      defaultImageHeight: user?.defaultImageHeight ?? 1024,
    })
    .returning({ id: documents.id, title: documents.title });

  logger.info(
    { documentId, pageCount: pageTexts.length, contentLength: content.length },
    'PDF document created',
  );

  return {
    documentId: document.id,
    title: document.title,
    pageCount: pageTexts.length,
  };
}

/**
 * Get a short-lived signed URL for a PDF document's original file.
 */
export async function getPdfSignedUrl(fileKey: string): Promise<string> {
  // 1-hour expiry is sufficient for viewer sessions
  return storageProvider.getSignedUrl(fileKey, 3600);
}
