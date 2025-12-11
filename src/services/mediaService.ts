import crypto from 'crypto';
import { db } from '../config/database';
import { media } from '../models/schema';
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
      const url = await storageProvider.getSignedUrl(existing[0].storageKey);
      logger.info({ mediaId: existing[0].id, hash }, 'Duplicate upload detected, returning existing');
      return { id: existing[0].id, storageKey: existing[0].storageKey, url };
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

  async getSignedUrl(id: string, userId: string, expiresIn: number = 900) {
    const mediaItem = await this.getById(id, userId);
    const url = await storageProvider.getSignedUrl(mediaItem.storageKey, expiresIn);
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

  private computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

export const mediaService = new MediaService();
