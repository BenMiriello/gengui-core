import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database';
import { documentMedia, documents, media, users } from '../models/schema';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { graphService } from './graph/graph.service';
import { getImageProvider } from './image-generation/factory';
import { mediaService } from './mediaService';
import { segmentService } from './segments';
import { sseService } from './sse';
import { summaryService } from './summarization';
import { versioningService } from './versioning';

const RETENTION_DAYS = 31;

function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

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

    logger.info(
      { userId, documentId: document.id, sourceDocumentId },
      'Document copied',
    );

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
      expectedVersion?: number;
      forceOverwrite?: boolean;
    },
  ) {
    const existing = await this.get(documentId, userId);

    if (
      !updates.forceOverwrite &&
      updates.expectedVersion !== undefined &&
      updates.expectedVersion !== existing.currentVersion
    ) {
      throw new ConflictError('Document was modified elsewhere', {
        currentVersion: existing.currentVersion,
        expectedVersion: updates.expectedVersion,
      });
    }

    // Validate dimensions if both are being updated
    if (
      updates.defaultImageWidth !== undefined &&
      updates.defaultImageHeight !== undefined
    ) {
      const provider = await getImageProvider();
      if (
        !provider.validateDimensions(
          updates.defaultImageWidth,
          updates.defaultImageHeight,
        )
      ) {
        const supportedDimensions = provider.getSupportedDimensions();
        let dimensionsStr: string;
        if (Array.isArray(supportedDimensions)) {
          dimensionsStr = supportedDimensions
            .map((d) => `${d.width}x${d.height}`)
            .join(', ');
        } else {
          const { min, max, step } = supportedDimensions;
          dimensionsStr = `${min}-${max}px (step: ${step})`;
        }
        throw new Error(
          `Dimensions ${updates.defaultImageWidth}x${updates.defaultImageHeight} not supported by ${provider.name} provider. Supported sizes: ${dimensionsStr}`,
        );
      }
    }

    // Snapshot the current DB state before overwriting
    let existingSegments:
      | { id: string; start: number; end: number }[]
      | undefined;
    let oldContent: string | undefined;
    let oldSummary: string | null | undefined;
    let oldSummaryEditChainLength: number | undefined;

    if (updates.content !== undefined) {
      const current = await this.get(documentId, userId);
      existingSegments = Array.isArray(current.segmentSequence)
        ? current.segmentSequence
        : [];
      oldContent = current.content ?? undefined;
      oldSummary = current.summary;
      oldSummaryEditChainLength = current.summaryEditChainLength;

      if (current.content || current.yjsState) {
        await versioningService.createVersion(
          documentId,
          current.yjsState ?? '',
          current.content ?? '',
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

    // Update summary if content changed
    if (updates.content !== undefined && oldContent !== undefined) {
      await this.updateDocumentSummary(
        documentId,
        oldContent,
        updates.content,
        oldSummary ?? null,
        oldSummaryEditChainLength ?? 0,
      );
    }

    sseService.broadcastToDocument(documentId, 'document-update', {
      updatedBy: userId,
      timestamp: new Date().toISOString(),
    });

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

  private async getDeleted(documentId: string, userId: string) {
    const [document] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), isNotNull(documents.deletedAt)))
      .limit(1);

    if (!document) {
      throw new NotFoundError('Deleted document not found');
    }
    if (document.userId !== userId) {
      throw new ForbiddenError('Not authorized to access this document');
    }
    return document;
  }

  async listDeleted(userId: string) {
    const threshold = getDaysAgo(RETENTION_DAYS);
    return db
      .select({
        id: documents.id,
        title: documents.title,
        deletedAt: documents.deletedAt,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.userId, userId),
          isNotNull(documents.deletedAt),
          gt(documents.deletedAt, threshold),
        ),
      )
      .orderBy(desc(documents.deletedAt));
  }

  async restore(documentId: string, userId: string) {
    await this.getDeleted(documentId, userId);
    const [updated] = await db
      .update(documents)
      .set({ deletedAt: null })
      .where(eq(documents.id, documentId))
      .returning();
    logger.info({ userId, documentId }, 'Document restored');
    return updated;
  }

  async getDeletedInfo(documentId: string, userId: string) {
    const doc = await this.getDeleted(documentId, userId);

    // Count media linked to this document
    const mediaResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(documentMedia)
      .innerJoin(media, eq(documentMedia.mediaId, media.id))
      .where(
        and(eq(documentMedia.documentId, documentId), eq(media.userId, userId)),
      );
    const mediaCount = Number(mediaResult[0]?.count ?? 0);

    // Count entities from FalkorDB
    let entityCount = 0;
    const hasAnalysis =
      doc.narrativeModeEnabled && doc.lastAnalyzedVersion !== null;
    if (hasAnalysis) {
      const result = await graphService.query(
        `MATCH (n:StoryNode {documentId: $documentId}) RETURN count(n) as count`,
        { documentId },
      );
      entityCount = (result.data[0]?.[0] as number) || 0;
    }

    return {
      id: doc.id,
      title: doc.title,
      hasAnalysis,
      entityCount,
      mediaCount,
    };
  }

  async permanentDelete(
    documentId: string,
    userId: string,
    options?: { deleteMedia?: boolean },
  ) {
    const doc = await this.getDeleted(documentId, userId);

    // Delete FalkorDB nodes for this document
    const hasAnalysis =
      doc.narrativeModeEnabled && doc.lastAnalyzedVersion !== null;
    if (hasAnalysis) {
      await graphService.deleteDocumentNodes(documentId);
    }

    // Optionally delete media files (not just links)
    if (options?.deleteMedia) {
      await mediaService.permanentDeleteDocumentMedia(documentId, userId);
    }

    // Hard delete document (cascades to documentMedia, mentions, versions via FK)
    await db.delete(documents).where(eq(documents.id, documentId));
    logger.info(
      { userId, documentId, deletedMedia: options?.deleteMedia },
      'Document permanently deleted',
    );
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

  /**
   * Update document summary based on content changes.
   * Uses progressive updates with unified diff format per TDD.
   */
  private async updateDocumentSummary(
    documentId: string,
    oldContent: string,
    newContent: string,
    currentSummary: string | null,
    editChainLength: number,
  ): Promise<void> {
    try {
      // Compute diff between old and new content
      const sourceDiff = summaryService.computeDiff(oldContent, newContent);

      // Check if changes are significant enough to update summary
      if (!summaryService.needsUpdate(sourceDiff)) {
        logger.debug(
          { documentId },
          'Content changes not significant, skipping summary update',
        );
        return;
      }

      let result: Awaited<ReturnType<typeof summaryService.generate>>;

      if (
        !currentSummary ||
        editChainLength >= summaryService.MAX_EDIT_CHAIN_LENGTH
      ) {
        // Generate fresh summary
        result = await summaryService.generate({
          summaryId: documentId,
          summaryType: 'document',
          sourceText: newContent,
          currentSummary: currentSummary ?? undefined,
          editChainLength,
        });
      } else {
        // Progressive update
        result = await summaryService.update({
          summaryId: documentId,
          summaryType: 'document',
          currentSummary,
          sourceDiff,
          editChainLength,
        });
      }

      // Update document with new summary
      if (result.method !== 'no_change') {
        await db
          .update(documents)
          .set({
            summary: result.summary,
            summaryEditChainLength: result.editChainLength,
            summaryUpdatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));

        logger.info(
          {
            documentId,
            method: result.method,
            editChainLength: result.editChainLength,
          },
          'Document summary updated',
        );
      }
    } catch (error) {
      logger.error({ documentId, error }, 'Failed to update document summary');
    }
  }
}

export const documentsService = new DocumentsService();
