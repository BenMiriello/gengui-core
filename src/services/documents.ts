import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database';
import { documents, users } from '../models/schema';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { getImageProvider } from './image-generation/factory';
import { segmentService } from './segments';
import { sseService } from './sse';
import { versioningService } from './versioning';

export class DocumentsService {
  async list(userId: string) {
    const userDocuments = await db
      .select({
        id: documents.id,
        userId: documents.userId,
        title: documents.title,
        content: documents.content,
        narrativeModeEnabled: documents.narrativeModeEnabled,
        mediaModeEnabled: documents.mediaModeEnabled,
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

    const segments = segmentService.computeSegments(content);

    const [document] = await db
      .insert(documents)
      .values({
        userId,
        title: generatedTitle,
        content,
        segmentSequence: segments,
        defaultImageWidth: user?.defaultImageWidth ?? 1024,
        defaultImageHeight: user?.defaultImageHeight ?? 1024,
      })
      .returning();

    logger.info({ userId, documentId: document.id }, 'Document created');

    return document;
  }

  async copy(sourceDocumentId: string, userId: string, newTitle: string) {
    const source = await this.get(sourceDocumentId, userId);

    const segments = segmentService.computeSegments(source.content);

    const [document] = await db
      .insert(documents)
      .values({
        userId,
        title: newTitle,
        content: source.content,
        contentJson: source.contentJson,
        yjsState: source.yjsState,
        segmentSequence: segments,
        defaultImageWidth: source.defaultImageWidth,
        defaultImageHeight: source.defaultImageHeight,
        mediaModeEnabled: false,
        narrativeModeEnabled: false,
      })
      .returning();

    logger.info({ userId, documentId: document.id, sourceDocumentId }, 'Document copied');

    return document;
  }

  async update(
    documentId: string,
    userId: string,
    updates: {
      content?: string;
      yjsState?: string;
      title?: string;
      defaultStylePreset?: string | null;
      defaultStylePrompt?: string | null;
      defaultImageWidth?: number;
      defaultImageHeight?: number;
      narrativeModeEnabled?: boolean;
      mediaModeEnabled?: boolean;
    }
  ) {
    await this.get(documentId, userId);

    // Validate dimensions if both are being updated
    if (updates.defaultImageWidth !== undefined && updates.defaultImageHeight !== undefined) {
      const provider = await getImageProvider();
      if (!provider.validateDimensions(updates.defaultImageWidth, updates.defaultImageHeight)) {
        const supportedDimensions = provider.getSupportedDimensions();
        let dimensionsStr: string;
        if (Array.isArray(supportedDimensions)) {
          dimensionsStr = supportedDimensions.map((d) => `${d.width}x${d.height}`).join(', ');
        } else {
          const { min, max, step } = supportedDimensions;
          dimensionsStr = `${min}-${max}px (step: ${step})`;
        }
        throw new Error(
          `Dimensions ${updates.defaultImageWidth}x${updates.defaultImageHeight} not supported by ${provider.name} provider. Supported sizes: ${dimensionsStr}`
        );
      }
    }

    // Snapshot the current DB state before overwriting
    let existingSegments: { id: string; start: number; end: number }[] | undefined;
    if (updates.content !== undefined) {
      const current = await this.get(documentId, userId);
      existingSegments = Array.isArray(current.segmentSequence) ? current.segmentSequence : [];
      if (current.content || current.yjsState) {
        await versioningService.createVersion(
          documentId,
          current.yjsState ?? '',
          current.content ?? ''
        );
      }
    }

    // Recompute segments if content changed
    const newSegments =
      updates.content !== undefined
        ? segmentService.computeSegments(updates.content, existingSegments)
        : undefined;

    const [updated] = await db
      .update(documents)
      .set({
        ...(updates.content !== undefined && { content: updates.content }),
        ...(newSegments !== undefined && { segmentSequence: newSegments }),
        ...(updates.yjsState !== undefined && { yjsState: updates.yjsState }),
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.defaultStylePreset !== undefined && {
          defaultStylePreset: updates.defaultStylePreset,
        }),
        ...(updates.defaultStylePrompt !== undefined && {
          defaultStylePrompt: updates.defaultStylePrompt,
        }),
        ...(updates.defaultImageWidth !== undefined && {
          defaultImageWidth: updates.defaultImageWidth,
        }),
        ...(updates.defaultImageHeight !== undefined && {
          defaultImageHeight: updates.defaultImageHeight,
        }),
        ...(updates.narrativeModeEnabled !== undefined && {
          narrativeModeEnabled: updates.narrativeModeEnabled,
        }),
        ...(updates.mediaModeEnabled !== undefined && {
          mediaModeEnabled: updates.mediaModeEnabled,
        }),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
      .returning();

    logger.info({ userId, documentId }, 'Document updated');

    sseService.broadcastToDocument(documentId, 'document-update', {
      updatedBy: userId,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  async delete(documentId: string, userId: string) {
    await this.get(documentId, userId);

    await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));

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
