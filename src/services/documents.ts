import { db } from '../config/database';
import { documents, users } from '../models/schema';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { NotFoundError, ConflictError, ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';
import { documentVersionsService } from './documentVersions';
import { sseService } from './sse';

export class DocumentsService {
  async list(userId: string) {
    const userDocuments = await db
      .select({
        id: documents.id,
        userId: documents.userId,
        title: documents.title,
        content: documents.content,
        version: documents.version,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt));

    return userDocuments;
  }

  async get(documentId: string, userId: string) {
    const [document] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
      .limit(1);

    if (!document) {
      throw new NotFoundError('Document not found');
    }

    if (document.userId !== userId) {
      throw new ForbiddenError('Not authorized to access this document');
    }

    return document;
  }

  async create(userId: string, title: string, content: string) {
    const generatedTitle = title || this.generateTitle(content);

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
        userId,
        title: generatedTitle,
        content,
        version: 1,
        currentVersionId: null,
        defaultImageWidth: user?.defaultImageWidth ?? 1024,
        defaultImageHeight: user?.defaultImageHeight ?? 1024,
      })
      .returning();

    const firstVersion = await documentVersionsService.createVersion(
      document.id,
      '',
      content,
      userId,
      { parentVersionId: null }
    );

    await db
      .update(documents)
      .set({ currentVersionId: firstVersion.id })
      .where(eq(documents.id, document.id));

    logger.info({ userId, documentId: document.id, versionId: firstVersion.id }, 'Document created');

    return { ...document, currentVersionId: firstVersion.id };
  }

  async update(
    documentId: string,
    userId: string,
    updates: {
      content?: string;
      title?: string;
      defaultStylePreset?: string | null;
      defaultStylePrompt?: string | null;
      defaultImageWidth?: number;
      defaultImageHeight?: number;
    },
    expectedVersion: number,
    cursorPosition?: { lineNumber?: number; charPosition?: number }
  ) {
    const document = await this.get(documentId, userId);

    if (document.version !== expectedVersion) {
      throw new ConflictError('Document has been modified. Please reload and try again.');
    }

    let newVersionId = document.currentVersionId;

    if (updates.content !== undefined && updates.content !== document.content) {
      logger.info({
        oldContentLength: document.content.length,
        newContentLength: updates.content.length,
        oldContentPreview: document.content.substring(0, 50),
        newContentPreview: updates.content.substring(0, 50),
      }, '[UPDATE] Creating version with diff');

      const newVersion = await documentVersionsService.createVersion(
        documentId,
        document.content,
        updates.content,
        userId,
        {
          parentVersionId: document.currentVersionId,
          lineNumber: cursorPosition?.lineNumber ?? null,
          charPosition: cursorPosition?.charPosition ?? null,
          changeType: 'replace',
        }
      );
      newVersionId = newVersion.id;
    }

    const [updated] = await db
      .update(documents)
      .set({
        ...(updates.content !== undefined && { content: updates.content }),
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.defaultStylePreset !== undefined && { defaultStylePreset: updates.defaultStylePreset }),
        ...(updates.defaultStylePrompt !== undefined && { defaultStylePrompt: updates.defaultStylePrompt }),
        ...(updates.defaultImageWidth !== undefined && { defaultImageWidth: updates.defaultImageWidth }),
        ...(updates.defaultImageHeight !== undefined && { defaultImageHeight: updates.defaultImageHeight }),
        version: document.version + 1,
        currentVersionId: newVersionId,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
      .returning();

    logger.info({ userId, documentId, versionId: newVersionId }, 'Document updated');

    sseService.broadcastToDocument(documentId, 'document-update', {
      version: updated.version,
      updatedBy: userId,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  async setCurrentVersion(documentId: string, userId: string, versionId: string) {
    await this.get(documentId, userId);

    const content = await documentVersionsService.reconstructContent(documentId, versionId);

    const [updated] = await db
      .update(documents)
      .set({
        content,
        currentVersionId: versionId,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
      .returning();

    logger.info({ userId, documentId, versionId }, 'Document current version updated');

    return updated;
  }

  async delete(documentId: string, userId: string) {
    await this.get(documentId, userId);

    await db
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(eq(documents.id, documentId));

    logger.info({ userId, documentId }, 'Document deleted');
  }

  private generateTitle(content: string): string {
    if (!content || content.trim().length === 0) {
      return 'Untitled Document';
    }

    const first50 = content.slice(0, 50).trim();

    if (first50.length <= 12) {
      return first50;
    }

    const lastSpaceIndex = first50.lastIndexOf(' ');
    if (lastSpaceIndex > 12) {
      return first50.slice(0, lastSpaceIndex);
    }

    return first50;
  }
}

export const documentsService = new DocumentsService();
