/**
 * Prompt augmentation worker.
 * Processes prompt enhancement using Gemini before submitting to image generation.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { documents, media } from '../../models/schema';
import { getGeminiClient } from '../../services/gemini';
import type { ReferenceImage } from '../../services/image-generation/types';
import { sseService } from '../../services/sse';
import { buildContext } from '../../services/prompt-augmentation/contextBuilder';
import { fetchEntityReferenceData } from '../../services/prompt-augmentation/entityReferences';
import type {
  EntityDescription,
  EntityReferences,
  PromptEnhancementSettings,
} from '../../services/prompt-augmentation/promptBuilder';
import { buildGeminiPrompt } from '../../services/prompt-augmentation/promptBuilder';
import { logger } from '../../utils/logger';
import { JobWorker } from '../worker';
import type { Job, JobProgress, JobType } from '../types';

interface AugmentationPayload {
  mediaId: string;
  documentId: string;
  selectedText: string;
  startChar: number;
  endChar: number;
  settings: PromptEnhancementSettings;
  stylePrompt: string;
  seed: number;
  width: number;
  height: number;
}

class PromptAugmentationWorker extends JobWorker<AugmentationPayload, JobProgress> {
  protected jobType: JobType = 'prompt_augmentation';

  constructor() {
    super('prompt-augmentation-worker');
  }

  protected async processJob(job: Job, payload: AugmentationPayload): Promise<void> {
    const {
      mediaId,
      documentId,
      selectedText,
      startChar,
      endChar,
      settings,
      stylePrompt,
      seed,
      width,
      height,
    } = payload;

    const userId = job.userId;

    logger.info(
      { jobId: job.id, mediaId, documentId, userId },
      'Processing prompt augmentation job',
    );

    try {
      const [document] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
        .limit(1);

      if (!document) {
        throw new Error('Document not found');
      }

      const entityRefs = this.normalizeEntityReferences(settings);

      let entityDescriptions: EntityDescription[] = [];
      let referenceImages: ReferenceImage[] | undefined;

      if (entityRefs) {
        const { getImageProviderName } = await import(
          '../../services/image-generation/factory.js'
        );
        const providerName = await getImageProviderName();
        const providerSupportsImages = providerName === 'gemini-pro-image';

        const entityData = await fetchEntityReferenceData(
          documentId,
          userId,
          entityRefs,
          selectedText,
        );

        if (
          entityRefs.useImages &&
          providerSupportsImages &&
          entityData.images.length > 0
        ) {
          referenceImages = entityData.images;
          logger.info(
            {
              mediaId,
              referenceCount: referenceImages.length,
              entityNames: referenceImages.map((r) => r.nodeName),
            },
            'Entity reference images prepared',
          );
        }

        if (entityRefs.useDescriptions && entityData.descriptions.length > 0) {
          entityDescriptions = entityData.descriptions;
          logger.info(
            {
              mediaId,
              descriptionCount: entityDescriptions.length,
              entityNames: entityDescriptions.map((d) => d.name),
            },
            'Entity descriptions prepared for Gemini augmentation',
          );
        }
      }

      const context = await buildContext(
        document.content,
        documentId,
        userId,
        selectedText,
        startChar,
        endChar,
        settings,
      );
      context.entityDescriptions = entityDescriptions;

      const geminiPrompt = buildGeminiPrompt(context, settings);

      logger.info(
        { mediaId, documentId },
        'Calling Gemini API for prompt augmentation',
      );
      const augmentedPrompt = await this.augmentPrompt(geminiPrompt);

      const finalPrompt = stylePrompt
        ? `${stylePrompt}\n\n${augmentedPrompt}`
        : augmentedPrompt;

      logger.info(
        {
          mediaId,
          originalLength: selectedText.length,
          augmentedLength: finalPrompt.length,
        },
        'Prompt augmented successfully',
      );

      await db
        .update(media)
        .set({
          status: 'queued',
          prompt: finalPrompt,
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId));

      const { getImageProvider, getReferenceImageProvider } = await import(
        '../../services/image-generation/factory.js'
      );
      const provider =
        referenceImages && referenceImages.length > 0
          ? getReferenceImageProvider()
          : await getImageProvider();

      await provider.submitJob({
        mediaId,
        userId,
        prompt: finalPrompt,
        seed,
        width,
        height,
        referenceImages,
      });

      logger.info(
        { mediaId, provider: provider.name },
        'Generation submitted to provider after successful augmentation',
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Augmentation failed. Please try again.';
      logger.error(
        { error, mediaId, documentId, errorMessage },
        'Prompt augmentation failed',
      );

      await this.failAugmentation(mediaId, documentId, errorMessage);
      throw error;
    }
  }

  private async augmentPrompt(geminiPrompt: string): Promise<string> {
    const client = await getGeminiClient();
    if (!client) {
      throw new Error(
        'Gemini API client not initialized - GEMINI_API_KEY missing',
      );
    }

    try {
      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: geminiPrompt,
      });

      if (!result) {
        throw new Error('Unable to augment prompt. Please try again.');
      }

      if (!result.candidates || result.candidates.length === 0) {
        const blockReason = result.promptFeedback?.blockReason;
        if (blockReason) {
          logger.error({ blockReason }, 'Content was blocked');
          throw new Error(
            'Unable to augment prompt. The content may contain inappropriate material.',
          );
        }
        throw new Error(
          'Unable to augment prompt. The content may have been filtered. Please try again.',
        );
      }

      const text = result.text;

      if (!text || text.trim().length === 0) {
        logger.error('Gemini returned empty response');
        throw new Error('Unable to augment prompt. Please try again.');
      }

      return text.trim();
    } catch (error: unknown) {
      const err = error as Error;
      logger.error({ error }, 'Gemini API error during augmentation');

      if (err?.message?.includes('quota')) {
        throw new Error('API quota exceeded. Please try again later.');
      }

      if (err?.message?.includes('rate limit')) {
        throw new Error(
          'Rate limit exceeded. Please wait a moment and try again.',
        );
      }

      if (err?.message?.includes('404')) {
        throw new Error(
          'Augmentation service not available. Please contact support.',
        );
      }

      if (
        err?.message?.includes('Unable to augment') ||
        err?.message?.includes('quota') ||
        err?.message?.includes('rate limit') ||
        err?.message?.includes('inappropriate material')
      ) {
        throw error;
      }

      throw new Error(
        `Augmentation failed: ${err?.message || 'Unknown error'}. Please try again.`,
      );
    }
  }

  private normalizeEntityReferences(
    settings: PromptEnhancementSettings,
  ): EntityReferences | null {
    if (settings.entityReferences) {
      return settings.entityReferences;
    }

    if (settings.characterReferences) {
      return {
        mode: settings.characterReferences.mode,
        selectedNodeIds: settings.characterReferences.selectedNodeIds,
        useImages: true,
        useDescriptions: false,
      };
    }

    return null;
  }

  private async failAugmentation(
    mediaId: string,
    documentId: string,
    errorMessage: string,
  ) {
    await db
      .update(media)
      .set({
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(media.id, mediaId));

    sseService.broadcastToDocument(documentId, 'augmentation-failed', {
      mediaId,
      documentId,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });

    logger.error(
      { mediaId, documentId, errorMessage },
      'Augmentation marked as failed',
    );
  }
}

export const promptAugmentationWorker = new PromptAugmentationWorker();
