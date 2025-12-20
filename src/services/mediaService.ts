import crypto from 'crypto';
import { db } from '../config/database';
import { media, documents, documentMedia } from '../models/schema';
import { eq, and, desc } from 'drizzle-orm';
import { notDeleted } from '../utils/db';
import { storageProvider } from './storage';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export class MediaService {
  async upload(
    userId: string,
    file: Express.Multer.File
  ): Promise<{ id: string; storageKey: string; url: string }> {
    const hash = this.computeHash(file.buffer);

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
          .set({ storageKey })
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
    logger.info({ mediaId: result.id, size: file.size }, 'Media uploaded successfully');

    return { id: result.id, storageKey: result.storageKey, url };
  }

  async list(userId: string, limit: number = 50, _cursor?: string) {
    const query = db
      .select()
      .from(media)
      .where(and(eq(media.userId, userId), notDeleted(media.deletedAt)))
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

  async getDocumentsByMediaId(mediaId: string, userId: string) {
    const results = await db
      .select()
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
      throw new NotFoundError('No documents found for this media');
    }

    console.log("Documents fetched in service:", results);
    return results.map(r => r.documents);
  }

  async getSignedUrl(id: string, userId: string, expiresIn: number = 900) {
    const mediaItem = await this.getById(id, userId);
    if (!mediaItem.storageKey && !mediaItem.s3Key) {
      throw new Error('Media has no storage key');
    }
    const key = mediaItem.s3Key || mediaItem.storageKey!;
    const url = await storageProvider.getSignedUrl(key, expiresIn);
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

    logger.info({ mediaId: id }, 'Media soft deleted');
    return result[0];
  }

  async getDocumentMedia(documentId: string) {
    const results = await db
      .select({
        id: media.id,
        userId: media.userId,
        type: media.type,
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
        requestedPrompt: documentMedia.requestedPrompt,
        versionId: documentMedia.versionId,
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
