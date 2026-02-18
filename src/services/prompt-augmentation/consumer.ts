/**
 * Redis stream consumer and orchestration for prompt augmentation
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { PubSubConsumer } from '../../lib/pubsub-consumer';
import { documents, media } from '../../models/schema';
import { logger } from '../../utils/logger';
import { getGeminiClient } from '../gemini';
import type { ReferenceImage } from '../image-generation/types';
import type { StreamMessage } from '../redis-streams';
import { sseService } from '../sse';
import { buildContext } from './contextBuilder';
import { fetchEntityReferenceData } from './entityReferences';
import type {
  EntityDescription,
  EntityReferences,
  PromptEnhancementSettings,
} from './promptBuilder';
import { buildGeminiPrompt } from './promptBuilder';

interface AugmentationJobData {
  mediaId: string;
  userId: string;
  documentId: string;
  selectedText: string;
  startChar: number;
  endChar: number;
  settings: string; // JSON string from Redis - must be parsed
  stylePrompt: string;
  seed: string;
  width: string;
  height: string;
}

class PromptAugmentationConsumer extends PubSubConsumer {
  protected streamName = 'prompt-augmentation:stream';
  protected groupName = 'prompt-augmentation-processors';
  protected consumerName = `prompt-augmentation-processor-${process.pid}`;

  constructor() {
    super('prompt-augmentation-service');
  }

  protected async handleMessage(message: StreamMessage) {
    const jobData = message.data as unknown as AugmentationJobData;
    const {
      mediaId,
      userId,
      documentId,
      selectedText,
      startChar,
      endChar,
      stylePrompt,
      seed,
      width,
      height,
    } = jobData;

    // Parse settings from JSON string (Redis stores all values as strings)
    const settings: PromptEnhancementSettings = JSON.parse(jobData.settings);

    if (!mediaId || !userId || !documentId) {
      logger.error({ data: message.data }, 'Augmentation request missing required fields');
      return;
    }

    logger.info({ mediaId, documentId, userId }, 'Processing prompt augmentation request');

    try {
      // Fetch document
      const [document] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
        .limit(1);

      if (!document) {
        logger.error({ documentId, userId }, 'Document not found');
        await this.failAugmentation(mediaId, documentId, 'Document not found');
        return;
      }

      // Normalize entity references (backward compatibility with characterReferences)
      const entityRefs = this.normalizeEntityReferences(settings);

      // Fetch entity reference data BEFORE building context (for Gemini to incorporate)
      let entityDescriptions: EntityDescription[] = [];
      let referenceImages: ReferenceImage[] | undefined;

      if (entityRefs) {
        const { getImageProviderName } = await import('../image-generation/factory.js');
        const providerName = await getImageProviderName();
        const providerSupportsImages = providerName === 'gemini-pro-image';

        const entityData = await fetchEntityReferenceData(
          documentId,
          userId,
          entityRefs,
          selectedText
        );

        if (entityRefs.useImages && providerSupportsImages && entityData.images.length > 0) {
          referenceImages = entityData.images;
          logger.info(
            {
              mediaId,
              referenceCount: referenceImages.length,
              entityNames: referenceImages.map((r) => r.nodeName),
            },
            'Entity reference images prepared'
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
            'Entity descriptions prepared for Gemini augmentation'
          );
        }
      }

      // Build context with entity descriptions for Gemini to incorporate
      const context = await buildContext(
        document.content,
        documentId,
        userId,
        selectedText,
        startChar,
        endChar,
        settings
      );
      context.entityDescriptions = entityDescriptions;

      // Build Gemini prompt (now includes entity descriptions)
      const geminiPrompt = buildGeminiPrompt(context, settings);

      // Call Gemini API
      logger.info({ mediaId, documentId }, 'Calling Gemini API for prompt augmentation');
      const augmentedPrompt = await this.augmentPrompt(geminiPrompt);

      // Combine style prompt with augmented prompt
      const finalPrompt = stylePrompt ? `${stylePrompt}\n\n${augmentedPrompt}` : augmentedPrompt;

      logger.info(
        { mediaId, originalLength: selectedText.length, augmentedLength: finalPrompt.length },
        'Prompt augmented successfully'
      );

      // Update media status to queued
      await db
        .update(media)
        .set({
          status: 'queued',
          prompt: finalPrompt,
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId));

      // Submit to configured image generation provider
      // Use reference image provider when references are present
      const { getImageProvider, getReferenceImageProvider } = await import(
        '../image-generation/factory.js'
      );
      const provider =
        referenceImages && referenceImages.length > 0
          ? getReferenceImageProvider()
          : await getImageProvider();

      await provider.submitJob({
        mediaId,
        userId,
        prompt: finalPrompt,
        seed: parseInt(seed, 10),
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        referenceImages,
      });

      logger.info(
        { mediaId, provider: provider.name },
        'Generation submitted to provider after successful augmentation'
      );
    } catch (error: any) {
      const errorMessage = error?.message || 'Augmentation failed. Please try again.';
      logger.error({ error, mediaId, documentId, errorMessage }, 'Prompt augmentation failed');

      await this.failAugmentation(mediaId, documentId, errorMessage);
    }
  }

  private async augmentPrompt(geminiPrompt: string): Promise<string> {
    const client = await getGeminiClient();
    if (!client) {
      throw new Error('Gemini API client not initialized - GEMINI_API_KEY missing');
    }

    try {
      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: geminiPrompt,
      });

      if (!result) {
        throw new Error('Unable to augment prompt. Please try again.');
      }

      // Check if the response was blocked or has no candidates
      if (!result.candidates || result.candidates.length === 0) {
        const blockReason = result.promptFeedback?.blockReason;
        if (blockReason) {
          logger.error({ blockReason }, 'Content was blocked');
          throw new Error(
            'Unable to augment prompt. The content may contain inappropriate material.'
          );
        }
        throw new Error(
          'Unable to augment prompt. The content may have been filtered. Please try again.'
        );
      }

      const text = result.text;

      if (!text || text.trim().length === 0) {
        logger.error('Gemini returned empty response');
        throw new Error('Unable to augment prompt. Please try again.');
      }

      return text.trim();
    } catch (error: any) {
      logger.error({ error }, 'Gemini API error during augmentation');

      // Handle specific error types
      if (error?.message?.includes('quota')) {
        throw new Error('API quota exceeded. Please try again later.');
      }

      if (error?.message?.includes('rate limit')) {
        throw new Error('Rate limit exceeded. Please wait a moment and try again.');
      }

      if (error?.message?.includes('404')) {
        throw new Error('Augmentation service not available. Please contact support.');
      }

      // Re-throw if it's already a formatted error message
      if (
        error?.message?.includes('Unable to augment') ||
        error?.message?.includes('quota') ||
        error?.message?.includes('rate limit') ||
        error?.message?.includes('inappropriate material')
      ) {
        throw error;
      }

      throw new Error(
        `Augmentation failed: ${error?.message || 'Unknown error'}. Please try again.`
      );
    }
  }

  private normalizeEntityReferences(settings: PromptEnhancementSettings): EntityReferences | null {
    if (settings.entityReferences) {
      return settings.entityReferences;
    }

    // Backward compatibility: map legacy characterReferences to entityReferences
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

  private async failAugmentation(mediaId: string, documentId: string, errorMessage: string) {
    // Update media status to failed
    await db
      .update(media)
      .set({
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(media.id, mediaId));

    // Broadcast error to user
    sseService.broadcastToDocument(documentId, 'augmentation-failed', {
      mediaId,
      documentId,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });

    logger.error({ mediaId, documentId, errorMessage }, 'Augmentation marked as failed');
  }
}

export const promptAugmentationService = new PromptAugmentationConsumer();
