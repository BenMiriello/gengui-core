import { db } from '../config/database';
import { tags, mediaTags, media } from '../models/schema';
import { eq, and } from 'drizzle-orm';
import { notDeleted } from '../utils/db';
import { NotFoundError, ConflictError } from '../utils/errors';
import { logger } from '../utils/logger';

export class TagService {
  async create(userId: string, name: string): Promise<{ id: string; name: string }> {
    const [tag] = await db
      .insert(tags)
      .values({ userId, name })
      .returning();

    logger.info({ tagId: tag.id, name }, 'Tag created');
    return { id: tag.id, name: tag.name };
  }

  async list(userId: string) {
    const userTags = await db
      .select()
      .from(tags)
      .where(eq(tags.userId, userId))
      .orderBy(tags.name);

    return userTags;
  }

  async addToMedia(mediaId: string, tagId: string, userId: string) {
    const mediaItem = await db
      .select()
      .from(media)
      .where(and(eq(media.id, mediaId), eq(media.userId, userId), notDeleted(media.deletedAt)))
      .limit(1);

    if (mediaItem.length === 0) {
      throw new NotFoundError('Media not found');
    }

    const tag = await db
      .select()
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
      .limit(1);

    if (tag.length === 0) {
      throw new NotFoundError('Tag not found');
    }

    const existing = await db
      .select()
      .from(mediaTags)
      .where(and(eq(mediaTags.mediaId, mediaId), eq(mediaTags.tagId, tagId)))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictError('Tag already added to media');
    }

    await db
      .insert(mediaTags)
      .values({ mediaId, tagId });

    logger.info({ mediaId, tagId }, 'Tag added to media');
    return { mediaId, tagId };
  }

  async removeFromMedia(mediaId: string, tagId: string, userId: string) {
    const mediaItem = await db
      .select()
      .from(media)
      .where(and(eq(media.id, mediaId), eq(media.userId, userId), notDeleted(media.deletedAt)))
      .limit(1);

    if (mediaItem.length === 0) {
      throw new NotFoundError('Media not found');
    }

    const tag = await db
      .select()
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
      .limit(1);

    if (tag.length === 0) {
      throw new NotFoundError('Tag not found');
    }

    const result = await db
      .delete(mediaTags)
      .where(and(eq(mediaTags.mediaId, mediaId), eq(mediaTags.tagId, tagId)))
      .returning();

    if (result.length === 0) {
      throw new NotFoundError('Tag not associated with media');
    }

    logger.info({ mediaId, tagId }, 'Tag removed from media');
    return { mediaId, tagId };
  }
}

export const tagService = new TagService();
