import { db } from '../config/database';
import { media, documentMedia, documents } from '../models/schema';
import { eq, and } from 'drizzle-orm';
import { notDeleted } from '../utils/db';
import { redis } from './redis';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface GenerationRequest {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  documentId?: string;
  startChar?: number;
  endChar?: number;
  sourceText?: string;
  nodePos?: number;
  textOffset?: number;
  contextBefore?: string;
  contextAfter?: string;
}

export class GenerationsService {
  async create(userId: string, request: GenerationRequest) {
    const seed = request.seed ?? Math.floor(Math.random() * 1000000);
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;

    let stylePreset: string | null = null;
    let stylePrompt: string | null = null;

    if (request.documentId) {
      const [document] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.documentId))
        .limit(1);

      if (document) {
        stylePreset = document.defaultStylePreset;
        stylePrompt = document.defaultStylePrompt;
      }
    }

    const [newMedia] = await db
      .insert(media)
      .values({
        userId,
        type: 'generation',
        status: 'queued',
        prompt: request.prompt,
        seed,
        width,
        height,
        stylePreset,
        stylePrompt,
      })
      .returning();

    if (request.documentId) {
      let contextBefore: string | undefined = request.contextBefore;
      let contextAfter: string | undefined = request.contextAfter;

      if (!contextBefore && !contextAfter && request.startChar !== undefined && request.endChar !== undefined) {
        const [document] = await db
          .select()
          .from(documents)
          .where(eq(documents.id, request.documentId))
          .limit(1);

        if (document) {
          const CONTEXT_LENGTH = 50;
          const content = document.content;

          const contextBeforeStart = Math.max(0, request.startChar - CONTEXT_LENGTH);
          contextBefore = content.substring(contextBeforeStart, request.startChar);

          const contextAfterEnd = Math.min(content.length, request.endChar + CONTEXT_LENGTH);
          contextAfter = content.substring(request.endChar, contextAfterEnd);
        }
      }

      await db.insert(documentMedia).values({
        documentId: request.documentId,
        mediaId: newMedia.id,
        startChar: request.startChar,
        endChar: request.endChar,
        sourceText: request.sourceText,
        nodePos: request.nodePos,
        textOffset: request.textOffset,
        contextBefore,
        contextAfter,
        requestedPrompt: request.prompt,
      });
    }

    try {
      await redis.addJob(newMedia.id, {
        userId,
        mediaId: newMedia.id,
        prompt: request.prompt,
        seed: seed.toString(),
        width: width.toString(),
        height: height.toString(),
        status: 'queued',
      });

      logger.info({ mediaId: newMedia.id, prompt: request.prompt }, 'Generation queued');
    } catch (error) {
      logger.error({ error, mediaId: newMedia.id }, 'Failed to queue generation, marking as failed');
      await db
        .update(media)
        .set({ status: 'failed', error: 'Failed to queue job' })
        .where(eq(media.id, newMedia.id));
      throw error;
    }

    return newMedia;
  }

  async getById(id: string, userId: string) {
    const result = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.id, id),
          eq(media.userId, userId),
          eq(media.type, 'generation'),
          notDeleted(media.deletedAt)
        )
      )
      .limit(1);

    if (result.length === 0) {
      throw new NotFoundError('Generation not found');
    }

    return result[0];
  }

  async list(userId: string, limit: number = 50) {
    const results = await db
      .select()
      .from(media)
      .where(
        and(
          eq(media.userId, userId),
          eq(media.type, 'generation'),
          notDeleted(media.deletedAt)
        )
      )
      .orderBy(media.createdAt)
      .limit(limit);

    return results;
  }
}

export const generationsService = new GenerationsService();
