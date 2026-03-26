import crypto from 'node:crypto';
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
} from 'drizzle-orm';
import { PRESIGNED_S3_URL_EXPIRATION } from '../config/constants';
import { db } from '../config/database';
import { documentMedia, documents, media, nodeMedia } from '../models/schema';
import { notDeleted } from '../utils/db';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { cache, type MediaUrlType } from './cache';
import { graphService } from './graph/graph.service';
import { imageProcessor } from './imageProcessor';
import { redisStreams } from './redis-streams';
import { storageProvider } from './storage';

export class MediaService {
  async upload(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ id: string; storageKey: string; url: string }> {
    const hash = this.computeHash(file.buffer);

    let dimensions: { width: number; height: number } | null = null;
    if (file.mimetype.startsWith('image/')) {
      try {
        dimensions = await imageProcessor.extractDimensions(file.buffer);
        logger.info(
          { width: dimensions.width, height: dimensions.height },
          'Dimensions extracted',
        );
      } catch (error) {
        logger.warn(
          { error },
          'Failed to extract dimensions, continuing without',
        );
      }
    }

    const existing = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.userId, userId),
          eq(media.hash, hash),
          notDeleted(media.deletedAt),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const existingMedia = existing[0];
      if (!existingMedia.storageKey) {
        throw new Error('Media record exists but has no storage key');
      }
      const url = await storageProvider.getSignedUrl(existingMedia.storageKey);
      logger.info(
        { mediaId: existingMedia.id, hash },
        'Duplicate upload detected, returning existing',
      );
      return {
        id: existingMedia.id,
        storageKey: existingMedia.storageKey,
        url,
      };
    }

    const result = await db.transaction(async (tx) => {
      const [newMedia] = await tx
        .insert(media)
        .values({
          userId,
          storageKey: '',
          size: file.size,
          mimeType: file.mimetype,
          hash,
          generated: false,
          width: dimensions?.width,
          height: dimensions?.height,
        })
        .returning();

      try {
        const storageKey = await storageProvider.upload(
          userId,
          newMedia.id,
          file.buffer,
          file.mimetype,
        );

        const [updated] = await tx
          .update(media)
          .set({
            storageKey,
            s3Key: storageKey,
          })
          .where(eq(media.id, newMedia.id))
          .returning();

        return updated;
      } catch (error) {
        logger.error(
          { error, mediaId: newMedia.id },
          'Storage upload failed, rolling back',
        );
        throw error;
      }
    });

    if (!result.storageKey) {
      throw new Error('Media upload completed but storage key is missing');
    }

    const url = await storageProvider.getSignedUrl(result.storageKey);

    if (file.mimetype.startsWith('image/')) {
      await redisStreams.add('thumbnail:stream', { mediaId: result.id });
      logger.info({ mediaId: result.id }, 'Queued thumbnail generation');
    }

    logger.info(
      { mediaId: result.id, size: file.size },
      'Media uploaded successfully',
    );

    return { id: result.id, storageKey: result.storageKey, url };
  }

  async list(
    userId: string,
    limit: number = 50,
    options?: { excludeRoles?: string[] },
  ) {
    const conditions = [eq(media.userId, userId), notDeleted(media.deletedAt)];

    if (options?.excludeRoles?.length) {
      const roleCondition = or(
        isNull(media.mediaRole),
        notInArray(media.mediaRole, options.excludeRoles),
      );
      if (roleCondition) {
        conditions.push(roleCondition);
      }
    }

    const query = db
      .select()
      .from(media)
      .where(and(...conditions))
      .orderBy(desc(media.createdAt))
      .limit(limit);

    const results = await query;

    return results;
  }

  async getById(id: string, userId: string) {
    const result = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.id, id),
          eq(media.userId, userId),
          notDeleted(media.deletedAt),
        ),
      )
      .limit(1);

    if (result.length === 0) {
      throw new NotFoundError('Media not found');
    }

    return result[0];
  }

  async getDocumentsByMediaId(
    mediaId: string,
    userId: string,
    requestedFields?: string[],
  ) {
    const allColumns = getTableColumns(documents);
    type ColumnsType = typeof allColumns;
    let selection: ColumnsType | Partial<ColumnsType> = allColumns;

    if (requestedFields && requestedFields.length > 0) {
      const pickedFields = {} as Record<string, unknown>;
      requestedFields.forEach((field) => {
        if (Object.hasOwn(allColumns, field)) {
          pickedFields[field] = allColumns[field as keyof ColumnsType];
        }
      });

      if (Object.keys(pickedFields).length > 0) {
        selection = pickedFields as ColumnsType;
      }
    }

    const results = await db
      .select(selection)
      .from(documents)
      .innerJoin(documentMedia, eq(documents.id, documentMedia.documentId))
      .where(
        and(
          eq(documentMedia.mediaId, mediaId),
          eq(documents.userId, userId),
          notDeleted(documents.deletedAt),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(100);

    if (results.length === 0) {
      return [];
    }

    return results;
  }

  async getNodeByMediaId(mediaId: string, userId: string) {
    // First get the nodeId from the Postgres nodeMedia table
    const [nodeMed] = await db
      .select({ nodeId: nodeMedia.nodeId })
      .from(nodeMedia)
      .where(
        and(eq(nodeMedia.mediaId, mediaId), notDeleted(nodeMedia.deletedAt)),
      )
      .limit(1);

    if (!nodeMed) {
      return null;
    }

    // Then fetch the node from FalkorDB
    const node = await graphService.getStoryNodeById(nodeMed.nodeId, userId);
    if (!node) {
      return null;
    }

    return {
      id: node.id,
      type: node.type,
      name: node.name,
      documentId: node.documentId,
    };
  }

  async getSignedUrl(
    id: string,
    userId: string,
    expiresIn: number = PRESIGNED_S3_URL_EXPIRATION,
    type: MediaUrlType = 'full',
  ) {
    const cachedUrl = await cache.getMediaUrl(id, type);
    if (cachedUrl) {
      return cachedUrl;
    }

    const mediaItem = await this.getById(id, userId);

    let key: string;
    if (type === 'thumb' && mediaItem.s3KeyThumb) {
      key = mediaItem.s3KeyThumb;
    } else if (mediaItem.s3Key) {
      key = mediaItem.s3Key;
    } else if (mediaItem.storageKey) {
      key = mediaItem.storageKey;
    } else {
      throw new Error('Media has no storage key');
    }

    const url = await storageProvider.getSignedUrl(key, expiresIn);
    await cache.setMediaUrl(id, type, url);

    return url;
  }

  async delete(id: string, userId: string) {
    const result = await db
      .update(media)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(media.id, id),
          eq(media.userId, userId),
          notDeleted(media.deletedAt),
        ),
      )
      .returning();

    if (result.length === 0) {
      throw new NotFoundError('Media not found or already deleted');
    }

    await cache.delMediaUrl(id);
    await cache.delMetadata(id);

    logger.info({ mediaId: id }, 'Media soft deleted');
    return result[0];
  }

  async getDocumentMedia(documentId: string) {
    const results = await db
      .select({
        id: media.id,
        userId: media.userId,
        sourceType: media.sourceType,
        status: media.status,
        storageKey: media.storageKey,
        s3Key: media.s3Key,
        s3KeyThumb: media.s3KeyThumb,
        s3Bucket: media.s3Bucket,
        size: media.size,
        mimeType: media.mimeType,
        hash: media.hash,
        width: media.width,
        height: media.height,
        prompt: media.prompt,
        seed: media.seed,
        error: media.error,
        generated: media.generated,
        createdAt: media.createdAt,
        updatedAt: media.updatedAt,
        startChar: documentMedia.startChar,
        endChar: documentMedia.endChar,
        sourceText: documentMedia.sourceText,
        contextBefore: documentMedia.contextBefore,
        contextAfter: documentMedia.contextAfter,
        nodePos: documentMedia.nodePos,
        textOffset: documentMedia.textOffset,
        requestedPrompt: documentMedia.requestedPrompt,
      })
      .from(documentMedia)
      .innerJoin(media, eq(documentMedia.mediaId, media.id))
      .where(
        and(
          eq(documentMedia.documentId, documentId),
          notDeleted(documentMedia.deletedAt),
          notDeleted(media.deletedAt),
        ),
      )
      .orderBy(desc(documentMedia.createdAt));

    return results;
  }

  async softDeleteDocumentMedia(
    documentId: string,
    userId: string,
  ): Promise<number> {
    const now = new Date();

    // Get all media IDs for this document that belong to the user
    const mediaItems = await db
      .select({ mediaId: documentMedia.mediaId })
      .from(documentMedia)
      .innerJoin(media, eq(documentMedia.mediaId, media.id))
      .where(
        and(
          eq(documentMedia.documentId, documentId),
          eq(media.userId, userId),
          notDeleted(documentMedia.deletedAt),
          notDeleted(media.deletedAt),
        ),
      );

    if (mediaItems.length === 0) {
      return 0;
    }

    const mediaIds = mediaItems.map((m) => m.mediaId);

    // Soft delete the media items
    await db
      .update(media)
      .set({ deletedAt: now })
      .where(
        and(
          eq(media.userId, userId),
          notDeleted(media.deletedAt),
          // Only delete media that's linked to this document
          inArray(media.id, mediaIds),
        ),
      );

    // Soft delete the document-media links
    await db
      .update(documentMedia)
      .set({ deletedAt: now })
      .where(
        and(
          eq(documentMedia.documentId, documentId),
          notDeleted(documentMedia.deletedAt),
        ),
      );

    // Clear cache for each media item
    for (const id of mediaIds) {
      await cache.delMediaUrl(id);
      await cache.delMetadata(id);
    }

    logger.info(
      { documentId, count: mediaIds.length },
      'Soft deleted document media',
    );
    return mediaIds.length;
  }

  async getDeletedDocumentMedia(documentId: string, userId: string) {
    const RETENTION_DAYS = 31;
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - RETENTION_DAYS);

    return db
      .select({
        id: media.id,
        s3KeyThumb: media.s3KeyThumb,
        s3Key: media.s3Key,
        prompt: media.prompt,
        deletedAt: documentMedia.deletedAt,
        createdAt: media.createdAt,
      })
      .from(documentMedia)
      .innerJoin(media, eq(documentMedia.mediaId, media.id))
      .where(
        and(
          eq(documentMedia.documentId, documentId),
          eq(media.userId, userId),
          isNotNull(documentMedia.deletedAt),
          gt(documentMedia.deletedAt, threshold),
        ),
      )
      .orderBy(desc(documentMedia.deletedAt));
  }

  async permanentDeleteDocumentMedia(
    documentId: string,
    userId: string,
  ): Promise<number> {
    // Get all media IDs linked to this document (owned by user)
    const mediaItems = await db
      .select({ mediaId: documentMedia.mediaId })
      .from(documentMedia)
      .innerJoin(media, eq(documentMedia.mediaId, media.id))
      .where(
        and(eq(documentMedia.documentId, documentId), eq(media.userId, userId)),
      );

    if (mediaItems.length === 0) return 0;

    const mediaIds = mediaItems.map((m) => m.mediaId);

    // Hard delete media files
    await db.delete(media).where(inArray(media.id, mediaIds));

    // Clear cache
    for (const id of mediaIds) {
      await cache.delMediaUrl(id);
      await cache.delMetadata(id);
    }

    logger.info(
      { documentId, count: mediaIds.length },
      'Permanently deleted document media',
    );
    return mediaIds.length;
  }

  async restoreDocumentMedia(
    documentId: string,
    userId: string,
  ): Promise<number> {
    // Find soft-deleted document-media links for this document
    // We query all links (including deleted) and filter in JS
    const allLinks = await db
      .select({
        mediaId: documentMedia.mediaId,
        deletedAt: documentMedia.deletedAt,
      })
      .from(documentMedia)
      .innerJoin(media, eq(documentMedia.mediaId, media.id))
      .where(
        and(eq(documentMedia.documentId, documentId), eq(media.userId, userId)),
      );

    // Get links that are deleted (deletedAt is not null)
    const restorable = allLinks.filter((link) => link.deletedAt !== null);

    if (restorable.length === 0) {
      return 0;
    }

    const mediaIds = restorable.map((m) => m.mediaId);

    // Restore the document-media links
    await db
      .update(documentMedia)
      .set({ deletedAt: null })
      .where(
        and(
          eq(documentMedia.documentId, documentId),
          inArray(documentMedia.mediaId, mediaIds),
        ),
      );

    // Restore the media items themselves
    await db
      .update(media)
      .set({ deletedAt: null })
      .where(and(eq(media.userId, userId), inArray(media.id, mediaIds)));

    logger.info(
      { documentId, count: mediaIds.length },
      'Restored document media',
    );
    return mediaIds.length;
  }

  private computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

export const mediaService = new MediaService();
