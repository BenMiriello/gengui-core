import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '../config/database';
import { documents, media, userStylePrompts, users } from '../models/schema';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import { buildSoftDeleteUpdate, getDaysAgo } from '../utils/softDelete';

export class CustomStylePromptsService {
  async list(userId: string) {
    const prompts = await db
      .select({
        id: userStylePrompts.id,
        name: userStylePrompts.name,
        prompt: userStylePrompts.prompt,
        createdAt: userStylePrompts.createdAt,
        updatedAt: userStylePrompts.updatedAt,
      })
      .from(userStylePrompts)
      .where(
        and(
          eq(userStylePrompts.userId, userId),
          isNull(userStylePrompts.deletedAt),
        ),
      )
      .orderBy(userStylePrompts.createdAt);

    return prompts;
  }

  async create(userId: string, name: string, prompt: string) {
    if (!name?.trim() || !prompt?.trim()) {
      throw new BadRequestError('Name and prompt are required');
    }

    if (name.length > 100) {
      throw new BadRequestError('Name must be 100 characters or less');
    }

    if (prompt.length > 2000) {
      throw new BadRequestError('Prompt must be 2000 characters or less');
    }

    const existingCount = await db
      .select({ count: userStylePrompts.id })
      .from(userStylePrompts)
      .where(
        and(
          eq(userStylePrompts.userId, userId),
          isNull(userStylePrompts.deletedAt),
        ),
      );

    if (existingCount.length >= 100) {
      throw new BadRequestError('Maximum 100 custom prompts allowed');
    }

    const [customPrompt] = await db
      .insert(userStylePrompts)
      .values({ userId, name: name.trim(), prompt: prompt.trim() })
      .returning();

    logger.info(
      { userId, promptId: customPrompt.id },
      'Custom style prompt created',
    );
    return customPrompt;
  }

  async update(
    promptId: string,
    userId: string,
    name?: string,
    prompt?: string,
  ) {
    await this.get(promptId, userId);

    const updates: any = { updatedAt: new Date() };
    if (name !== undefined) {
      if (!name.trim()) throw new BadRequestError('Name cannot be empty');
      if (name.length > 100)
        throw new BadRequestError('Name must be 100 characters or less');
      updates.name = name.trim();
    }
    if (prompt !== undefined) {
      if (!prompt.trim()) throw new BadRequestError('Prompt cannot be empty');
      updates.prompt = prompt.trim();
    }

    const [updated] = await db
      .update(userStylePrompts)
      .set(updates)
      .where(eq(userStylePrompts.id, promptId))
      .returning();

    logger.info({ userId, promptId }, 'Custom style prompt updated');
    return updated;
  }

  async softDelete(promptId: string, userId: string) {
    await this.get(promptId, userId);

    await db
      .update(userStylePrompts)
      .set(buildSoftDeleteUpdate())
      .where(eq(userStylePrompts.id, promptId));

    await db
      .update(documents)
      .set({ defaultStylePreset: 'none', defaultStylePrompt: null })
      .where(
        and(
          eq(documents.userId, userId),
          eq(documents.defaultStylePreset, promptId),
        ),
      );

    await db
      .update(media)
      .set({ stylePreset: 'none', stylePrompt: null })
      .where(and(eq(media.userId, userId), eq(media.stylePreset, promptId)));

    const [user] = await db
      .select({ defaultStylePreset: users.defaultStylePreset })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user?.defaultStylePreset === promptId) {
      await db
        .update(users)
        .set({ defaultStylePreset: 'none' })
        .where(eq(users.id, userId));
    }

    logger.info({ userId, promptId }, 'Custom style prompt soft deleted');
  }

  async hardDelete(promptId: string) {
    await db.delete(userStylePrompts).where(eq(userStylePrompts.id, promptId));
  }

  async get(promptId: string, userId: string) {
    const [prompt] = await db
      .select()
      .from(userStylePrompts)
      .where(
        and(
          eq(userStylePrompts.id, promptId),
          isNull(userStylePrompts.deletedAt),
        ),
      )
      .limit(1);

    if (!prompt) {
      throw new NotFoundError('Custom style prompt not found');
    }

    if (prompt.userId !== userId) {
      throw new ForbiddenError('Not authorized to access this prompt');
    }

    return prompt;
  }

  async cleanupDeleted() {
    const thirtyOneDaysAgo = getDaysAgo(31);

    const deleted = await db
      .delete(userStylePrompts)
      .where(and(lt(userStylePrompts.deletedAt, thirtyOneDaysAgo)))
      .returning({ id: userStylePrompts.id });

    logger.info(
      { count: deleted.length },
      'Cleaned up deleted custom style prompts',
    );
    return deleted.length;
  }
}

export const customStylePromptsService = new CustomStylePromptsService();
