import { db } from '../config/database';
import { documents, storyNodes, storyNodeConnections, media } from '../models/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { sseService } from './sse';
import type { StreamMessage } from './redis-streams';
import { GoogleGenAI } from '@google/genai';
import { BlockingConsumer } from '../lib/blocking-consumer';
import { s3 } from './s3';
import type { ReferenceImage } from './image-generation/types';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  logger.warn('GEMINI_API_KEY not configured');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;

interface CharacterReferences {
  mode: 'auto' | 'manual';
  selectedNodeIds?: string[];
}

interface PromptEnhancementSettings {
  enabled: boolean;
  charsBefore: number;
  charsAfter: number;
  useNarrativeContext: boolean;
  sceneTreatment: 'comprehensive' | 'focused' | 'selective-detail';
  selectiveDetailFocus?: string;
  strength: 'low' | 'medium' | 'high';
  characterReferences?: CharacterReferences;
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

class PromptAugmentationService extends BlockingConsumer {
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

      // Handle character references if enabled
      let referenceImages: ReferenceImage[] | undefined;
      if (settings.characterReferences) {
        referenceImages = await this.fetchCharacterReferenceImages(
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
      const { getImageProvider, getReferenceImageProvider } = await import('./image-generation/factory.js');
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

    try {
      const result = await genAI.models.generateContent({
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

  /**
   * Fetch character reference images based on settings
   */
  private async fetchCharacterReferenceImages(
    documentId: string,
    userId: string,
    characterRefs: CharacterReferences,
    selectedText: string
  ): Promise<ReferenceImage[]> {
    // Get all character nodes for this document
    const allCharacterNodes = await db
      .select()
      .from(storyNodes)
      .where(
        and(
          eq(storyNodes.documentId, documentId),
          eq(storyNodes.userId, userId),
          eq(storyNodes.type, 'character')
        )
      );

    if (allCharacterNodes.length === 0) {
      logger.info({ documentId }, 'No character nodes found for document');
      return [];
    }

    // Determine which character node IDs to use
    let targetNodeIds: string[];

    if (characterRefs.mode === 'manual' && characterRefs.selectedNodeIds) {
      // Manual mode: use selected node IDs directly
      targetNodeIds = characterRefs.selectedNodeIds;
    } else {
      // Auto mode: detect characters in selected text using Gemini
      targetNodeIds = await this.detectCharactersInText(selectedText, allCharacterNodes);
    }

    if (targetNodeIds.length === 0) {
      logger.info({ documentId, mode: characterRefs.mode }, 'No character nodes selected for references');
      return [];
    }

    // Filter to nodes that have primaryMediaId set
    const nodesWithMedia = allCharacterNodes.filter(
      node => targetNodeIds.includes(node.id) && node.primaryMediaId
    );

    if (nodesWithMedia.length === 0) {
      logger.info(
        { documentId, targetNodeIds },
        'Selected character nodes have no primary media set'
      );
      return [];
    }

    // Fetch media records for primary images
    const mediaIds = nodesWithMedia.map(n => n.primaryMediaId!);
    const mediaRecords = await db
      .select()
      .from(media)
      .where(inArray(media.id, mediaIds));

    // Create a map for quick lookup
    const mediaMap = new Map(mediaRecords.map(m => [m.id, m]));

    // Download images from S3 and build reference array
    const referenceImages: ReferenceImage[] = [];

    for (const node of nodesWithMedia) {
      const mediaRecord = mediaMap.get(node.primaryMediaId!);
      if (!mediaRecord?.s3Key) {
        logger.warn({ nodeId: node.id, nodeName: node.name }, 'Primary media missing s3Key');
        continue;
      }

      try {
        const buffer = await s3.downloadBuffer(mediaRecord.s3Key);
        referenceImages.push({
          buffer,
          mimeType: mediaRecord.mimeType || 'image/jpeg',
          nodeId: node.id,
          nodeName: node.name,
        });
      } catch (error) {
        logger.error(
          { error, nodeId: node.id, nodeName: node.name, s3Key: mediaRecord.s3Key },
          'Failed to download reference image'
        );
        // Continue with other images
      }
    }

    // Limit to 5 reference images per Gemini API limits
    if (referenceImages.length > 5) {
      logger.warn(
        { count: referenceImages.length },
        'Limiting reference images to 5 for Gemini API'
      );
      return referenceImages.slice(0, 5);
    }

    return referenceImages;
  }

  /**
   * Use Gemini to detect which characters appear in the selected text
   */
  private async detectCharactersInText(
    selectedText: string,
    characterNodes: Array<{ id: string; name: string; description: string | null }>
  ): Promise<string[]> {
    if (!genAI) {
      logger.warn('Gemini not available for character detection, skipping auto mode');
      return [];
    }

    if (characterNodes.length === 0) {
      return [];
    }

    // Build character list for the prompt
    const characterList = characterNodes.map(
      c => `- ID: ${c.id}, Name: ${c.name}`
    ).join('\n');

    const prompt = `You are analyzing a passage of text to identify which characters from a known list appear or are mentioned.

KNOWN CHARACTERS:
${characterList}

TEXT TO ANALYZE:
${selectedText}

INSTRUCTIONS:
1. Read the text carefully and identify any characters from the known list that appear, are mentioned, or are referenced (even indirectly).
2. A character is "mentioned" if their name appears, they are referred to by a pronoun with clear context, or they are described in a way that identifies them.
3. Return ONLY a JSON array of character IDs that appear in the text.
4. If no known characters appear, return an empty array: []

Return your answer as a JSON array of IDs only, like: ["id1", "id2"]`;

    try {
      const result = await genAI.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: prompt,
      });

      const text = result.text?.trim();
      if (!text) {
        logger.warn('Empty response from Gemini for character detection');
        return [];
      }

      // Parse the JSON array from the response
      // Handle potential markdown code blocks
      let jsonText = text;
      if (text.includes('```')) {
        const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
          jsonText = match[1];
        }
      }

      const nodeIds = JSON.parse(jsonText);
      if (!Array.isArray(nodeIds)) {
        logger.warn({ response: text }, 'Invalid response format for character detection');
        return [];
      }

      // Validate that returned IDs are in our list
      const validIds = new Set(characterNodes.map(c => c.id));
      const filteredIds = nodeIds.filter((id: string) => validIds.has(id));

      logger.info(
        { detectedCount: filteredIds.length, detectedCharacters: filteredIds },
        'Characters detected in text'
      );

      return filteredIds;
    } catch (error) {
      logger.error({ error }, 'Failed to detect characters in text');
      return [];
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
