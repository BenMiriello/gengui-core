import crypto from 'crypto';
import { db } from '../config/database';
import { media, documents, documentMedia, nodeMedia, storyNodes } from '../models/schema';
import { eq, and, desc, getTableColumns, or, isNull, notInArray } from 'drizzle-orm';
import { notDeleted } from '../utils/db';
import { storageProvider } from './storage';
import { redisStreams } from './redis-streams';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { imageProcessor } from './imageProcessor';
import { cache, type MediaUrlType } from './cache';
import { PRESIGNED_S3_URL_EXPIRATION } from '../config/constants';
import { redis } from './redis';

export class MediaService {
  async upload(
    userId: string,
    file: Express.Multer.File
  ): Promise<{ id: string; storageKey: string; url: string }> {
    const hash = this.computeHash(file.buffer);

    let dimensions: { width: number; height: number } | null = null;
    if (file.mimetype.startsWith('image/')) {
      try {
        dimensions = await imageProcessor.extractDimensions(file.buffer);
        logger.info({ width: dimensions.width, height: dimensions.height }, 'Dimensions extracted');
      } catch (error) {
        logger.warn({ error }, 'Failed to extract dimensions, continuing without');
      }
    }

    const existing = await db
      .select()
      .from(media)
      .where(and(eq(media.userId, userId), eq(media.hash, hash), notDeleted(media.deletedAt)))
      .limit(1);

    if (existing.length > 0) {
      const existingMedia = existing[0];
      if (!existingMedia.storageKey) {
        throw new Error('Media record exists but has no storage key');
      }
      const url = await storageProvider.getSignedUrl(existingMedia.storageKey);
      logger.info({ mediaId: existingMedia.id, hash }, 'Duplicate upload detected, returning existing');
      return { id: existingMedia.id, storageKey: existingMedia.storageKey, url };
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
          file.mimetype
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
        logger.error({ error, mediaId: newMedia.id }, 'Storage upload failed, rolling back');
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

    logger.info({ mediaId: result.id, size: file.size }, 'Media uploaded successfully');

    return { id: result.id, storageKey: result.storageKey, url };
  }

  async list(userId: string, limit: number = 50, options?: { excludeRoles?: string[] }) {
    const conditions = [eq(media.userId, userId), notDeleted(media.deletedAt)];

    if (options?.excludeRoles?.length) {
      conditions.push(
        or(
          isNull(media.mediaRole),
          notInArray(media.mediaRole, options.excludeRoles)
        )!
      );
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
      .where(and(eq(media.id, id), eq(media.userId, userId), notDeleted(media.deletedAt)))
      .limit(1);

    if (result.length === 0) {
      throw new NotFoundError('Media not found');
    }

    return result[0];
  }

async getDocumentsByMediaId(mediaId: string, userId: string, requestedFields?: string[]) {
  const allColumns = getTableColumns(documents);
  let selection: Record<string, any> = allColumns;

  if (requestedFields && requestedFields.length > 0) {
    const pickedFields: Record<string, any> = {};
    requestedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(allColumns, field)) {
        pickedFields[field] = allColumns[field as keyof typeof allColumns];
      }
    });

    if (Object.keys(pickedFields).length > 0) {
      selection = pickedFields;
    }
  }

  const results = await db
    .select(selection)
    .from(documents)
    .innerJoin(documentMedia, eq(documents.id, documentMedia.documentId))
    .where(and(
      eq(documentMedia.mediaId, mediaId),
      eq(documents.userId, userId),
      notDeleted(documents.deletedAt)
    ))
    .orderBy(desc(documents.createdAt))
    .limit(100);

  if (results.length === 0) {
    return [];
  }

  return results as any[];
}

  async getNodeByMediaId(mediaId: string, userId: string) {
    const results = await db
      .select({
        id: storyNodes.id,
        type: storyNodes.type,
        name: storyNodes.name,
        documentId: storyNodes.documentId,
      })
      .from(storyNodes)
      .innerJoin(nodeMedia, eq(storyNodes.id, nodeMedia.nodeId))
      .where(and(
        eq(nodeMedia.mediaId, mediaId),
        eq(storyNodes.userId, userId),
        notDeleted(storyNodes.deletedAt),
        notDeleted(nodeMedia.deletedAt)
      ))
      .limit(1);

    return results.length > 0 ? results[0] : null;
  }

  async getSignedUrl(id: string, userId: string, expiresIn: number = PRESIGNED_S3_URL_EXPIRATION, type: MediaUrlType = 'full') {
    const cachedUrl = await cache.getMediaUrl(id, type);
    if (cachedUrl) {
      return cachedUrl;
    }

    const mediaItem = await this.getById(id, userId);

    let key: string;
    if (type === 'thumb' && mediaItem.s3KeyThumb) {
      key = mediaItem.s3KeyThumb;
    } else if (mediaItem.storageKey || mediaItem.s3Key) {
      key = mediaItem.s3Key || mediaItem.storageKey!;
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
      .where(and(eq(media.id, id), eq(media.userId, userId), notDeleted(media.deletedAt)))
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
          notDeleted(media.deletedAt)
        )
      )
      .orderBy(desc(documentMedia.createdAt));

    return results;
  }

  private computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

export const mediaService = new MediaService();
