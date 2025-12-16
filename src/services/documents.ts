import { db } from '../config/database';
import { documents } from '../models/schema';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { NotFoundError, ConflictError, ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';

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

    const [document] = await db
      .insert(documents)
      .values({
        userId,
        title: generatedTitle,
        content,
        version: 1,
      })
      .returning();

    logger.info({ userId, documentId: document.id }, 'Document created');

    return document;
  }

  async update(
    documentId: string,
    userId: string,
    updates: { content?: string; title?: string },
    expectedVersion: number
  ) {
    const document = await this.get(documentId, userId);

    if (document.version !== expectedVersion) {
      throw new ConflictError('Document has been modified. Please reload and try again.');
    }

    const [updated] = await db
      .update(documents)
      .set({
        ...(updates.content !== undefined && { content: updates.content }),
        ...(updates.title !== undefined && { title: updates.title }),
        version: document.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
      .returning();

    logger.info({ userId, documentId }, 'Document updated');

    return updated;
  }

  async delete(documentId: string, userId: string) {
    const document = await this.get(documentId, userId);

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
