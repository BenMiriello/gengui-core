import { db } from '../config/database';
import { documents, storyNodes, storyNodeConnections, media } from '../models/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { sseService } from './sse';
import { redisStreams, StreamMessage } from './redis-streams';
import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  logger.warn('GEMINI_API_KEY not configured');
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

interface PromptEnhancementSettings {
  enabled: boolean;
  charsBefore: number;
  charsAfter: number;
  useNarrativeContext: boolean;
  sceneTreatment: 'comprehensive' | 'focused' | 'selective-detail';
  selectiveDetailFocus?: string;
  strength: 'low' | 'medium' | 'high';
}

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

class PromptAugmentationService {
  private isRunning = false;

  async start() {
    if (this.isRunning) {
      logger.warn('Prompt augmentation service already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting prompt augmentation service...');

    await redisStreams.ensureGroupOnce('prompt-augmentation:stream', 'prompt-augmentation-processors');

    this.consumeMessages();

    logger.info('Prompt augmentation service started successfully');
  }

  stop() {
    this.isRunning = false;
    logger.info('Stopping prompt augmentation service...');
  }

  private async consumeMessages() {
    const consumerName = `prompt-augmentation-processor-${process.pid}`;

    while (this.isRunning) {
      try {
        const result = await redisStreams.consume(
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
            await redisStreams.ack('prompt-augmentation:stream', 'prompt-augmentation-processors', result.id);
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
      await redisStreams.ack(streamName, groupName, message.id);
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
        await redisStreams.ack(streamName, groupName, message.id);
        return;
      }

      // Build context
      const context = await this.buildContext(
        document.content,
        documentId,
        userId,
        selectedText,
        startChar,
        endChar,
        settings
      );

      // Build Gemini prompt
      const geminiPrompt = this.buildGeminiPrompt(context, settings);

      // Call Gemini API
      logger.info({ mediaId, documentId }, 'Calling Gemini API for prompt augmentation');
      const augmentedPrompt = await this.augmentPrompt(geminiPrompt);

      // Combine style prompt with augmented prompt
      const finalPrompt = stylePrompt
        ? `${stylePrompt}\n\n${augmentedPrompt}`
        : augmentedPrompt;

      logger.info({ mediaId, originalLength: selectedText.length, augmentedLength: finalPrompt.length }, 'Prompt augmented successfully');

      // Update media status to queued
      await db
        .update(media)
        .set({
          status: 'queued',
          prompt: finalPrompt,
          updatedAt: new Date()
        })
        .where(eq(media.id, mediaId));

      // Queue generation job
      await redisStreams.add('generation:stream', {
        userId,
        mediaId,
        prompt: finalPrompt,
        seed,
        width,
        height,
        status: 'queued',
      });

      logger.info({ mediaId }, 'Generation queued after successful augmentation');

      await redisStreams.ack(streamName, groupName, message.id);
    } catch (error: any) {
      const errorMessage = error?.message || 'Augmentation failed. Please try again.';
      logger.error({ error, mediaId, documentId, errorMessage }, 'Prompt augmentation failed');

      await this.failAugmentation(mediaId, documentId, errorMessage);
      await redisStreams.ack(streamName, groupName, message.id);
    }
  }

  private async buildContext(
    documentContent: string,
    documentId: string,
    userId: string,
    selectedText: string,
    startChar: number,
    endChar: number,
    settings: PromptEnhancementSettings
  ): Promise<{
    storyContext?: string;
    textBefore?: string;
    selectedText: string;
    textAfter?: string;
  }> {
    const context: any = {
      selectedText,
    };

    // Add narrative context if requested
    if (settings.useNarrativeContext) {
      const nodes = await db
        .select()
        .from(storyNodes)
        .where(and(eq(storyNodes.documentId, documentId), eq(storyNodes.userId, userId)));

      if (nodes.length > 0) {
        // Get connections
        const nodeIds = nodes.map(n => n.id);
        const connections = await db
          .select()
          .from(storyNodeConnections)
          .where(
            and(
              inArray(storyNodeConnections.fromNodeId, nodeIds),
              inArray(storyNodeConnections.toNodeId, nodeIds)
            )
          );

        // Convert to text
        context.storyContext = this.convertNodeTreeToText(nodes, connections);
      }
    }

    // Add surrounding text context
    if (settings.charsBefore > 0) {
      const beforeStart = Math.max(0, startChar - settings.charsBefore);
      context.textBefore = documentContent.substring(beforeStart, startChar);
    }

    if (settings.charsAfter > 0) {
      const afterEnd = Math.min(documentContent.length, endChar + settings.charsAfter);
      context.textAfter = documentContent.substring(endChar, afterEnd);
    }

    return context;
  }

  private convertNodeTreeToText(
    nodes: any[],
    connections: any[]
  ): string {
    const sections: string[] = ['STORY CONTEXT:\n'];

    // Group nodes by type
    const nodesByType: Record<string, any[]> = {
      character: [],
      location: [],
      event: [],
      other: [],
    };

    for (const node of nodes) {
      nodesByType[node.type]?.push(node);
    }

    // Add characters
    if (nodesByType.character.length > 0) {
      sections.push('\nCHARACTERS:');
      for (const node of nodesByType.character) {
        sections.push(`- ${node.name} (${node.type}): ${node.description}`);
      }
    }

    // Add locations
    if (nodesByType.location.length > 0) {
      sections.push('\nLOCATIONS:');
      for (const node of nodesByType.location) {
        sections.push(`- ${node.name} (${node.type}): ${node.description}`);
      }
    }

    // Add events
    if (nodesByType.event.length > 0) {
      sections.push('\nEVENTS:');
      for (const node of nodesByType.event) {
        sections.push(`- ${node.name} (${node.type}): ${node.description}`);
      }
    }

    // Add other elements
    if (nodesByType.other.length > 0) {
      sections.push('\nOTHER ELEMENTS:');
      for (const node of nodesByType.other) {
        sections.push(`- ${node.name} (${node.type}): ${node.description}`);
      }
    }

    // Add relationships
    if (connections.length > 0) {
      sections.push('\nRELATIONSHIPS:');
      const nodeMap = new Map(nodes.map(n => [n.id, n.name]));
      for (const conn of connections) {
        const fromName = nodeMap.get(conn.fromNodeId);
        const toName = nodeMap.get(conn.toNodeId);
        if (fromName && toName) {
          sections.push(`- ${fromName} → ${toName}: ${conn.description}`);
        }
      }
    }

    return sections.join('\n');
  }

  private buildGeminiPrompt(
    context: {
      storyContext?: string;
      textBefore?: string;
      selectedText: string;
      textAfter?: string;
    },
    settings: PromptEnhancementSettings
  ): string {
    const sections: string[] = [
      'You are helping generate an image prompt for a story scene.',
      '',
    ];

    // Add story context if available
    if (context.storyContext) {
      sections.push(context.storyContext);
      sections.push('');
    }

    // Add text before if available
    if (context.textBefore) {
      sections.push('TEXT BEFORE SELECTION (for context):');
      sections.push(context.textBefore);
      sections.push('');
    }

    // Add selected text (always included)
    sections.push('SELECTED TEXT TO VISUALIZE:');
    sections.push(context.selectedText);
    sections.push('');

    // Add text after if available
    if (context.textAfter) {
      sections.push('TEXT AFTER SELECTION (for context):');
      sections.push(context.textAfter);
      sections.push('');
    }

    // Add critical instructions
    sections.push('CRITICAL INSTRUCTIONS:');
    sections.push('1. Character/location descriptions from story context show their general state. Use surrounding text to understand their appearance AT THIS SPECIFIC MOMENT.');
    sections.push('2. Events that happen AFTER the selected text do not inform the image. They\'re included only for scene descriptors.');
    sections.push('3. Focus only on relevant information. Lots of context is provided - assess what matters for THIS moment.');
    sections.push('4. Capture the mood and feel of this moment in the story.');
    sections.push('5. Do NOT specify art style (e.g., painting, anime, realistic). Focus on subject, scene, mood only.');
    sections.push('');

    // Add scene treatment instructions
    sections.push(`SCENE TREATMENT - ${this.getSceneTreatmentLabel(settings.sceneTreatment)}:`);
    sections.push(this.getSceneTreatmentInstructions(settings));
    sections.push('');

    // Add strength instructions
    sections.push(`STRENGTH - ${this.getStrengthLabel(settings.strength)}:`);
    sections.push(this.getStrengthInstructions(settings.strength));
    sections.push('');

    sections.push('Generate a detailed, vivid image generation prompt. Return ONLY the prompt text, no explanation.');

    return sections.join('\n');
  }

  private getSceneTreatmentLabel(treatment: string): string {
    const labels: Record<string, string> = {
      'comprehensive': 'Comprehensive',
      'focused': 'Focused',
      'selective-detail': 'Selective Detail',
    };
    return labels[treatment] || 'Comprehensive';
  }

  private getSceneTreatmentInstructions(settings: PromptEnhancementSettings): string {
    switch (settings.sceneTreatment) {
      case 'comprehensive':
        return 'Include as many relevant elements as possible: all mentioned characters, objects, setting details, and atmospheric elements.';
      case 'focused':
        return 'Include only essential elements: primary characters, key objects, and main setting. Exclude background details.';
      case 'selective-detail':
        if (settings.selectiveDetailFocus) {
          return `Focus on this specific detail: ${settings.selectiveDetailFocus}. Use close-up framing. Provide enough context but exclude irrelevant elements.`;
        } else {
          return 'Select ONE evocative detail from the scene. Use close-up framing. Provide enough context (e.g., \'a weathered hand\' not just \'a hand\'). Choose something visually striking - a face, object, body part, or scene detail. Vary your selection to keep it interesting.';
        }
      default:
        return 'Include as many relevant elements as possible.';
    }
  }

  private getStrengthLabel(strength: string): string {
    const labels: Record<string, string> = {
      'low': 'Low',
      'medium': 'Medium',
      'high': 'High',
    };
    return labels[strength] || 'Medium';
  }

  private getStrengthInstructions(strength: string): string {
    switch (strength) {
      case 'low':
        return 'Make minimal adjustments. Clarify ambiguities and add essential visual details only. Preserve the user\'s original phrasing.';
      case 'medium':
        return 'You may restructure, add vivid descriptors, and remove redundant text. Keep the core subject and scene intact.';
      case 'high':
        return 'Fully rewrite for optimal image generation. Add artistic details, lighting, composition, mood. Preserve only the essential subject, scene, and setting.';
      default:
        return 'You may restructure, add vivid descriptors, and remove redundant text. Keep the core subject and scene intact.';
    }
  }

  private async augmentPrompt(geminiPrompt: string): Promise<string> {
    if (!genAI) {
      throw new Error('Gemini API client not initialized - GEMINI_API_KEY missing');
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
    });

    try {
      const result = await model.generateContent(geminiPrompt);

      if (!result?.response) {
        throw new Error('Unable to augment prompt. Please try again.');
      }

      const response = result.response;

      // Check if the response was blocked or has no candidates
      if (!response.candidates || response.candidates.length === 0) {
        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) {
          logger.error({ blockReason }, 'Content was blocked');
          throw new Error('Unable to augment prompt. The content may contain inappropriate material.');
        }
        throw new Error('Unable to augment prompt. The content may have been filtered. Please try again.');
      }

      const text = response.text();

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

export const promptAugmentationService = new PromptAugmentationService();
