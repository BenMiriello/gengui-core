/**
 * Redis stream consumer and orchestration for prompt augmentation
 */

import { db } from '../../config/database';
import { documents, media } from '../../models/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { sseService } from '../sse';
import type { StreamMessage } from '../redis-streams';
import { getGeminiClient } from '../gemini';
import { BlockingConsumer } from '../../lib/blocking-consumer';
import type { ReferenceImage } from '../image-generation/types';
import type { PromptEnhancementSettings } from './promptBuilder';
import { buildGeminiPrompt } from './promptBuilder';
import { buildContext } from './contextBuilder';
import { fetchCharacterReferenceImages } from './characterReferences';

interface AugmentationJobData {
  mediaId: string;
  userId: string;
  documentId: string;
  selectedText: string;
  startChar: number;
  endChar: number;
  settings: PromptEnhancementSettings;
  stylePrompt: string;
  seed: string;
  width: string;
  height: string;
}

class PromptAugmentationConsumer extends BlockingConsumer {
  constructor() {
    super('prompt-augmentation-service');
  }

  protected async onStart() {
    await this.streams.ensureGroupOnce('prompt-augmentation:stream', 'prompt-augmentation-processors');
  }

  protected async consumeLoop() {
    const consumerName = `prompt-augmentation-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await this.streams.consume(
          'prompt-augmentation:stream',
          'prompt-augmentation-processors',
          consumerName,
          {
            block: 2000,
            count: 1,
          }
        );

        if (result) {
          try {
            await this.handleAugmentationRequest(
              'prompt-augmentation:stream',
              'prompt-augmentation-processors',
              result
            );
          } catch (error) {
            logger.error({ error, messageId: result.id }, 'Error processing augmentation request');
            await this.streams.ack('prompt-augmentation:stream', 'prompt-augmentation-processors', result.id);
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error in prompt augmentation consumer loop');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleAugmentationRequest(
    streamName: string,
    groupName: string,
    message: StreamMessage
  ) {
    const jobData = message.data as unknown as AugmentationJobData;
    const { mediaId, userId, documentId, selectedText, startChar, endChar, settings, stylePrompt, seed, width, height } = jobData;

    if (!mediaId || !userId || !documentId) {
      logger.error({ data: message.data }, 'Augmentation request missing required fields');
      await this.streams.ack(streamName, groupName, message.id);
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
        await this.streams.ack(streamName, groupName, message.id);
        return;
      }

      // Build context
      const context = await buildContext(
        document.content,
        documentId,
        userId,
        selectedText,
        startChar,
        endChar,
        settings
      );

      // Build Gemini prompt
      const geminiPrompt = buildGeminiPrompt(context, settings);

      // Call Gemini API
      logger.info({ mediaId, documentId }, 'Calling Gemini API for prompt augmentation');
      const augmentedPrompt = await this.augmentPrompt(geminiPrompt);

      // Combine style prompt with augmented prompt
      const finalPrompt = stylePrompt
        ? `${stylePrompt}\n\n${augmentedPrompt}`
        : augmentedPrompt;

      logger.info({ mediaId, originalLength: selectedText.length, augmentedLength: finalPrompt.length }, 'Prompt augmented successfully');

      // Handle character references if enabled
      let referenceImages: ReferenceImage[] | undefined;
      if (settings.characterReferences) {
        referenceImages = await fetchCharacterReferenceImages(
          documentId,
          userId,
          settings.characterReferences,
          selectedText
        );

        if (referenceImages.length > 0) {
          logger.info(
            {
              mediaId,
              referenceCount: referenceImages.length,
              characterNames: referenceImages.map(r => r.nodeName),
            },
            'Character reference images prepared'
          );
        }
      }

      // Update media status to queued
      await db
        .update(media)
        .set({
          status: 'queued',
          prompt: finalPrompt,
          updatedAt: new Date()
        })
        .where(eq(media.id, mediaId));

      // Submit to configured image generation provider
      // Use reference image provider when references are present
      const { getImageProvider, getReferenceImageProvider } = await import('../image-generation/factory.js');
      const provider = referenceImages && referenceImages.length > 0
        ? getReferenceImageProvider()
        : await getImageProvider();

      await provider.submitJob({
        mediaId,
        userId,
        prompt: finalPrompt,
        seed: parseInt(seed),
        width: parseInt(width),
        height: parseInt(height),
        referenceImages,
      });

      logger.info({ mediaId, provider: provider.name }, 'Generation submitted to provider after successful augmentation');

      await this.streams.ack(streamName, groupName, message.id);
    } catch (error: any) {
      const errorMessage = error?.message || 'Augmentation failed. Please try again.';
      logger.error({ error, mediaId, documentId, errorMessage }, 'Prompt augmentation failed');

      await this.failAugmentation(mediaId, documentId, errorMessage);
      await this.streams.ack(streamName, groupName, message.id);
    }
  }

  private async augmentPrompt(geminiPrompt: string): Promise<string> {
    const client = await getGeminiClient();
    if (!client) {
      throw new Error('Gemini API client not initialized - GEMINI_API_KEY missing');
    }

    try {
      const result = await client.models.generateContent({
        model: 'gemini-2.0-flash-exp', // v1beta API - experimental has quota
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
          throw new Error('Unable to augment prompt. The content may contain inappropriate material.');
        }
        throw new Error('Unable to augment prompt. The content may have been filtered. Please try again.');
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
      if (error?.message?.includes('Unable to augment') ||
          error?.message?.includes('quota') ||
          error?.message?.includes('rate limit') ||
          error?.message?.includes('inappropriate material')) {
        throw error;
      }

      throw new Error(`Augmentation failed: ${error?.message || 'Unknown error'}. Please try again.`);
    }
  }

  private async failAugmentation(mediaId: string, documentId: string, errorMessage: string) {
    // Update media status to failed
    await db
      .update(media)
      .set({
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date()
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
