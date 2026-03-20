/**
 * Service for generating character sheet images from story nodes.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database';
import {
  getDimensionsForAspectRatio,
  getModelIdForProvider,
} from '../config/models';
import { media, nodeMedia } from '../models/schema';
import type {
  AspectRatio,
  CharacterSheetSettings,
  EntityContext,
  FacetInfo,
  FeaturedEntity,
} from '../types/generationSettings';
import { GENERATION_SETTINGS_SCHEMA_VERSION } from '../types/generationSettings';
import { extractJson } from '../utils/llmUtils';
import { logger } from '../utils/logger';
import { activityService } from './activity.service';
import { GeminiType, getGeminiClient } from './gemini/core';
import { graphService, type StoredStoryNode } from './graph/graph.service';
import type { StoredFacet } from './graph/graph.types';
import {
  getImageProvider,
  getImageProviderName,
} from './image-generation/factory';
import { s3 } from './s3';
import { sseService } from './sse';

interface GenerateCharacterSheetParams {
  nodeId: string;
  userId: string;
  settings: CharacterSheetSettings;
  aspectRatio?: AspectRatio;
  stylePreset?: string | null;
  stylePrompt?: string | null;
  cursorPosition?: number;
}

export const characterSheetService = {
  /**
   * Generate a character sheet image for a story node.
   */
  async generate({
    nodeId,
    userId,
    settings,
    aspectRatio,
    stylePreset,
    stylePrompt,
    cursorPosition,
  }: GenerateCharacterSheetParams) {
    // Fetch node and verify ownership from FalkorDB
    const node = await graphService.getStoryNodeById(nodeId, userId);

    if (!node) {
      throw new Error('Node not found');
    }

    // Determine aspect ratio: explicit param > settings > default based on node type
    const defaultAR: AspectRatio =
      node.type === 'character'
        ? 'portrait'
        : node.type === 'location'
          ? 'landscape'
          : 'square';
    const finalAR = aspectRatio ?? settings.aspectRatio ?? defaultAR;

    // Get dimensions for the current provider
    const providerName = await getImageProviderName();
    const modelId = getModelIdForProvider(providerName);
    const { width, height } = getDimensionsForAspectRatio(finalAR, modelId);

    // Use provided style or fall back to node's style
    const finalStylePreset =
      stylePreset !== undefined ? stylePreset : node.stylePreset;
    const finalStylePrompt =
      stylePrompt !== undefined ? stylePrompt : node.stylePrompt;

    // Get position-relevant facets if available
    const facets = await this.getPositionRelevantFacets(
      nodeId,
      node.documentId,
      cursorPosition,
    );

    // Build prompt from node + settings + style + facets
    // Uses async version to leverage LLM for visual relevance inference (TDD Section 7.4)
    const prompt = await this.buildPromptWithFacetsAsync(
      node,
      settings,
      finalStylePrompt,
      facets,
      cursorPosition ?? 0,
    );

    // Build entity context for this character sheet
    const facetInfos: FacetInfo[] = facets.map((f) => ({
      id: f.id,
      nodeId: f.entityId,
      type: f.type as 'appearance' | 'state' | 'trait' | 'name',
      content: f.content,
    }));

    const featuredEntity: FeaturedEntity = {
      nodeId,
      name: node.name,
      type: node.type,
      usedReference: false,
    };

    const entityContext: EntityContext = {
      featured: [featuredEntity],
      mentioned: [],
      facets: facetInfos.length > 0 ? facetInfos : undefined,
      cursorPosition,
    };

    // Create media record
    const [newMedia] = await db
      .insert(media)
      .values({
        userId,
        sourceType: 'generation',
        status: 'queued',
        mediaRole: 'character_sheet',
        prompt,
        width,
        height,
        stylePreset: finalStylePreset,
        stylePrompt: finalStylePrompt,
        generationSettings: {
          type: 'character_sheet',
          settings: { ...settings, aspectRatio: finalAR },
          entityContext,
        },
        generationSettingsSchemaVersion: GENERATION_SETTINGS_SCHEMA_VERSION,
      })
      .returning();

    // Create node_media association
    await db.insert(nodeMedia).values({
      nodeId,
      mediaId: newMedia.id,
    });

    // Create activity for progress tracking
    try {
      const activity = await activityService.createFromMedia({
        mediaId: newMedia.id,
        userId,
        title: `Generating ${node.name} image`,
      });
      logger.info(
        { activityId: activity.id, mediaId: newMedia.id, nodeId },
        'Activity created for character sheet generation',
      );
    } catch (activityError) {
      logger.error(
        { error: activityError, mediaId: newMedia.id },
        'Failed to create activity for character sheet generation',
      );
    }

    // Submit to image generation provider
    const provider = await getImageProvider();
    await provider.submitJob({
      mediaId: newMedia.id,
      userId,
      prompt,
      seed: Math.floor(Math.random() * 1000000),
      width,
      height,
    });

    logger.info(
      { mediaId: newMedia.id, nodeId, aspectRatio: finalAR, width, height },
      'Character sheet generation queued',
    );

    return newMedia;
  },

  /**
   * Build generation prompt from node description, settings, and style.
   * Style prompt goes FIRST for maximum weight with Imagen.
   */
  buildPrompt(
    node: { type: string; name: string; description: string | null },
    settings: CharacterSheetSettings,
    stylePrompt?: string | null,
  ): string {
    const parts: string[] = [];

    // STYLE FIRST - Imagen weights the beginning of prompts more heavily
    if (stylePrompt) {
      parts.push(stylePrompt);
    }

    // Use custom description if manual edit, otherwise generate from name
    // NOTE: node.description may contain document text, not visual description
    let baseDescription: string;
    if (settings.manualEdit && settings.customDescription) {
      baseDescription = settings.customDescription;
    } else if (node.type === 'character') {
      baseDescription = `Portrait of ${node.name}`;
    } else if (node.type === 'location') {
      baseDescription = `View of ${node.name}`;
    } else {
      baseDescription = node.name;
    }

    parts.push(baseDescription);

    // Add framing for characters
    if (node.type === 'character' && settings.framing) {
      if (settings.framing === 'portrait') {
        parts.push('Portrait shot, head and shoulders, upper body only.');
      } else if (settings.framing === 'full_body') {
        parts.push('Full body shot, head to toe, complete figure visible.');
      }
    }

    // Add perspective for locations
    if (node.type === 'location' && settings.perspective) {
      if (settings.perspective === 'exterior') {
        parts.push('Exterior view, seen from outside.');
      } else if (settings.perspective === 'interior') {
        parts.push('Interior view, seen from inside.');
      } else if (
        settings.perspective === 'custom' &&
        settings.perspectiveCustom
      ) {
        parts.push(settings.perspectiveCustom);
      }
    }

    // Add background
    if (settings.background === 'white') {
      parts.push(
        'Plain white background, no other elements, isolated subject.',
      );
    } else if (settings.background === 'black') {
      parts.push(
        'Plain black background, no other elements, isolated subject.',
      );
    } else if (settings.background === 'transparent') {
      parts.push('Transparent background, isolated subject, no environment.');
    } else if (settings.background === 'custom' && settings.backgroundCustom) {
      parts.push(`Background: ${settings.backgroundCustom}`);
    }

    // Quality hints - only add generic ones if no style prompt provided
    if (stylePrompt) {
      parts.push('Clear lighting, detailed, high quality.');
    } else {
      parts.push(
        'Reference sheet style, clear lighting, detailed, high quality.',
      );
    }

    return parts.join(' ');
  },

  /**
   * Build generation prompt using facets for more precise descriptions.
   * Falls back to buildPrompt if no facets available.
   *
   * Per TDD 2026-02-23 Section 7.4: Only include visual attributes in image prompts.
   * Exclude personality traits, internal states, and non-visual information.
   *
   * NOTE: This is a synchronous wrapper. For state facets, use buildPromptWithFacetsAsync
   * which calls the LLM to infer visual relevance (the TDD-correct approach).
   */
  buildPromptWithFacets(
    node: StoredStoryNode,
    settings: CharacterSheetSettings,
    stylePrompt: string | null | undefined,
    facets: StoredFacet[],
  ): string {
    // If no facets, fall back to legacy buildPrompt
    if (!facets || facets.length === 0) {
      return this.buildPrompt(node, settings, stylePrompt);
    }

    // Separate facets by type
    const appearanceFacets = facets.filter((f) => f.type === 'appearance');
    const stateFacets = facets.filter((f) => f.type === 'state');

    // Build visual attributes:
    // - Appearance facets are visual by definition (TDD Section 7.4)
    // - State facets excluded in sync version - use buildPromptWithFacetsAsync for LLM inference
    const visualAttributes = appearanceFacets.map((f) => f.content);

    return this.buildPromptFromVisualAttributes(
      node,
      settings,
      stylePrompt,
      visualAttributes,
      stateFacets.length > 0,
    );
  },

  /**
   * Build generation prompt using LLM to infer visual relevance of state facets.
   * This is the TDD-correct approach per Section 7.4.
   *
   * @param position - Document position for context (used in LLM inference)
   */
  async buildPromptWithFacetsAsync(
    node: StoredStoryNode,
    settings: CharacterSheetSettings,
    stylePrompt: string | null | undefined,
    facets: StoredFacet[],
    position: number = 0,
  ): Promise<string> {
    // If no facets, fall back to legacy buildPrompt
    if (!facets || facets.length === 0) {
      return this.buildPrompt(node, settings, stylePrompt);
    }

    // If manual edit, skip LLM inference
    if (settings.manualEdit && settings.customDescription) {
      return this.buildPromptFromVisualAttributes(
        node,
        settings,
        stylePrompt,
        [settings.customDescription],
        false,
      );
    }

    // Separate facets by type
    const appearanceFacets = facets.filter((f) => f.type === 'appearance');
    const stateFacets = facets.filter((f) => f.type === 'state');

    // Use LLM to infer which facets are visually relevant (TDD Section 7.4)
    // This is the PRIMARY method - appearance facets are passed directly,
    // state facets are evaluated by LLM for visual relevance
    const visualAttributes = await this.inferVisuallyRelevantFacets(
      node.name,
      position,
      appearanceFacets,
      stateFacets,
    );

    return this.buildPromptFromVisualAttributes(
      node,
      settings,
      stylePrompt,
      visualAttributes,
      false,
    );
  },

  /**
   * Build the final prompt from visual attributes.
   * Shared between sync and async versions.
   */
  buildPromptFromVisualAttributes(
    node: StoredStoryNode,
    settings: CharacterSheetSettings,
    stylePrompt: string | null | undefined,
    visualAttributes: string[],
    _hasExcludedStateFacets: boolean,
  ): string {
    const parts: string[] = [];

    // STYLE FIRST - Imagen weights the beginning of prompts more heavily
    if (stylePrompt) {
      parts.push(stylePrompt);
    }

    // If manual edit, use custom description
    if (settings.manualEdit && settings.customDescription) {
      parts.push(settings.customDescription);
    } else if (visualAttributes.length > 0) {
      // Build from visual attributes
      parts.push(`${node.name}: ${visualAttributes.join(', ')}`);
    } else {
      // Fall back to node name as subject (description may be document text, not visual)
      // Use type-appropriate phrasing
      if (node.type === 'character') {
        parts.push(`Portrait of ${node.name}`);
      } else if (node.type === 'location') {
        parts.push(`View of ${node.name}`);
      } else {
        parts.push(node.name);
      }
    }

    // Note: hasExcludedStateFacets is informational only - we could log it
    // if we want to track when state facets were excluded

    // Add framing for characters
    if (node.type === 'character' && settings.framing) {
      if (settings.framing === 'portrait') {
        parts.push('Portrait shot, head and shoulders, upper body only.');
      } else if (settings.framing === 'full_body') {
        parts.push('Full body shot, head to toe, complete figure visible.');
      }
    }

    // Add perspective for locations
    if (node.type === 'location' && settings.perspective) {
      if (settings.perspective === 'exterior') {
        parts.push('Exterior view, seen from outside.');
      } else if (settings.perspective === 'interior') {
        parts.push('Interior view, seen from inside.');
      } else if (
        settings.perspective === 'custom' &&
        settings.perspectiveCustom
      ) {
        parts.push(settings.perspectiveCustom);
      }
    }

    // Add background
    if (settings.background === 'white') {
      parts.push(
        'Plain white background, no other elements, isolated subject.',
      );
    } else if (settings.background === 'black') {
      parts.push(
        'Plain black background, no other elements, isolated subject.',
      );
    } else if (settings.background === 'transparent') {
      parts.push('Transparent background, isolated subject, no environment.');
    } else if (settings.background === 'custom' && settings.backgroundCustom) {
      parts.push(`Background: ${settings.backgroundCustom}`);
    }

    // Quality hints
    if (stylePrompt) {
      parts.push('Clear lighting, detailed, high quality.');
    } else {
      parts.push(
        'Reference sheet style, clear lighting, detailed, high quality.',
      );
    }

    return parts.join(' ');
  },

  /**
   * Get facets relevant to a specific position in the document.
   * Uses position-based validity queries (Phase 4) to return:
   * - Permanent facets (attached to entity)
   * - Phase-bounded facets (from active CharacterState at position)
   *
   * Per TDD 2026-02-23: All queries are position-based. There is no "current"
   * vs "historical" - everything exists on the timeline.
   */
  async getPositionRelevantFacets(
    nodeId: string,
    _documentId: string,
    cursorPosition?: number,
  ): Promise<StoredFacet[]> {
    // If no position, use position 0 (start of document)
    const position = cursorPosition ?? 0;

    // Use the position-based graph query from Phase 4
    // This returns permanent facets (on entity) + phase-bounded facets (from active state)
    const activeFacets = await graphService.getActiveFacetsAtPosition(
      nodeId,
      position,
    );

    return activeFacets;
  },

  /**
   * Set the primary media for a node.
   */
  async setPrimaryMedia(
    nodeId: string,
    mediaId: string | null,
    userId: string,
  ) {
    const node = await graphService.getStoryNodeById(nodeId, userId);

    if (!node) {
      throw new Error('Node not found');
    }

    if (mediaId !== null) {
      const [association] = await db
        .select()
        .from(nodeMedia)
        .where(
          and(
            eq(nodeMedia.nodeId, nodeId),
            eq(nodeMedia.mediaId, mediaId),
            isNull(nodeMedia.deletedAt),
          ),
        )
        .limit(1);

      if (!association) {
        throw new Error('Media is not associated with this node');
      }
    }

    await graphService.updateStoryNodePrimaryMedia(nodeId, mediaId);

    logger.info({ nodeId, mediaId }, 'Primary media updated for node');

    await this.broadcastPrimaryMediaUpdate(node.documentId, nodeId, mediaId);

    return { success: true };
  },

  async broadcastPrimaryMediaUpdate(
    documentId: string,
    nodeId: string,
    mediaId: string | null,
  ): Promise<void> {
    try {
      if (mediaId === null) {
        sseService.broadcastToDocument(
          documentId,
          'node-primary-media-updated',
          {
            documentId,
            nodeId,
            primaryMediaId: null,
            primaryMediaUrl: null,
          },
        );
        return;
      }

      const [mediaRecord] = await db
        .select({
          s3KeyThumb: media.s3KeyThumb,
          s3Key: media.s3Key,
        })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (!mediaRecord) {
        logger.warn({ mediaId }, 'Media record not found for primary update');
        return;
      }

      const key = mediaRecord.s3KeyThumb || mediaRecord.s3Key;
      if (!key) {
        logger.warn({ mediaId }, 'No S3 key for primary media');
        return;
      }

      const primaryMediaUrl = await s3.generateDownloadUrl(key);

      sseService.broadcastToDocument(documentId, 'node-primary-media-updated', {
        documentId,
        nodeId,
        primaryMediaId: mediaId,
        primaryMediaUrl,
      });

      logger.debug(
        { documentId, nodeId, mediaId },
        'Broadcasted node primary media update',
      );
    } catch (error) {
      logger.error(
        { error, documentId, nodeId, mediaId },
        'Failed to broadcast primary media update',
      );
    }
  },

  /**
   * Get all character sheets for a node.
   */
  async getNodeMedia(nodeId: string, userId: string) {
    // Verify node ownership from FalkorDB
    const node = await graphService.getStoryNodeById(nodeId, userId);

    if (!node) {
      throw new Error('Node not found');
    }

    // Get associated media (still in Postgres)
    const results = await db
      .select({
        id: media.id,
        status: media.status,
        s3Key: media.s3Key,
        s3KeyThumb: media.s3KeyThumb,
        prompt: media.prompt,
        mediaRole: media.mediaRole,
        generationSettings: media.generationSettings,
        createdAt: media.createdAt,
      })
      .from(nodeMedia)
      .innerJoin(media, eq(nodeMedia.mediaId, media.id))
      .where(
        and(
          eq(nodeMedia.nodeId, nodeId),
          isNull(nodeMedia.deletedAt),
          isNull(media.deletedAt),
        ),
      )
      .orderBy(media.createdAt);

    return {
      node,
      media: results,
      primaryMediaId: node.primaryMediaId,
    };
  },

  /**
   * Use LLM to infer visual relevance of facets at a specific position.
   * Per TDD 2026-02-23 Section 7.4: Provide context and let LLM determine
   * which attributes are visually relevant at this narrative moment.
   *
   * This is the PRIMARY method for visual relevance determination.
   * Falls back to appearance-only filtering if LLM unavailable.
   */
  async inferVisuallyRelevantFacets(
    entityName: string,
    position: number,
    permanentFacets: StoredFacet[],
    stateFacets: StoredFacet[],
    nearbyContext?: string,
  ): Promise<string[]> {
    const client = await getGeminiClient();

    // Fallback when LLM unavailable: only use appearance facets
    // (appearance is visual by definition, state facets require LLM to classify)
    if (!client) {
      const appearanceFacets = permanentFacets.filter(
        (f) => f.type === 'appearance',
      );
      return appearanceFacets.map((f) => f.content);
    }

    const prompt = `You are creating an image for "${entityName}" at narrative position ${position}.

PERSISTENT ATTRIBUTES (attached to entity):
${permanentFacets.map((f) => `- [${f.type}] ${f.content}`).join('\n') || '(none)'}

PHASE ATTRIBUTES (from active CharacterState):
${stateFacets.map((f) => `- [${f.type}] ${f.content}`).join('\n') || '(none)'}

${nearbyContext ? `NEARBY CONTEXT:\n${nearbyContext}\n` : ''}

TASK:
Determine which attributes are visually relevant for generating an image at this moment.
- Include persistent appearance attributes unless clearly contradicted
- Include phase attributes only if visually apparent (wounds, disguises, clothing)
- Exclude personality traits, emotions, internal states, non-visual information

Return ONLY the visually relevant attributes as a JSON array of strings.
Example: ["tall with brown hair", "wearing armor", "visible scar on cheek"]`;

    // Timeout for visual inference - don't block image generation too long
    const VISUAL_INFERENCE_TIMEOUT_MS = 3000;

    try {
      const inferencePromise = client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: GeminiType.ARRAY,
            items: { type: GeminiType.STRING },
          },
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('Visual inference timeout')),
          VISUAL_INFERENCE_TIMEOUT_MS,
        );
      });

      const result = await Promise.race([inferencePromise, timeoutPromise]);

      const text = result.text?.trim();
      if (!text) {
        throw new Error('Empty response from Gemini');
      }

      // Use shared JSON extraction utility with type validation
      const parsed = extractJson<string[]>(text);
      if (!parsed || !Array.isArray(parsed)) {
        throw new Error('Invalid response format from Gemini');
      }

      return parsed;
    } catch (error) {
      const isTimeout =
        error instanceof Error && error.message === 'Visual inference timeout';
      logger.warn(
        { error, entityName, position, isTimeout },
        isTimeout
          ? 'Visual inference timed out, using appearance-only fallback'
          : 'LLM visual inference failed, using appearance-only fallback',
      );

      // Fallback: only appearance facets (visual by definition)
      // State facets excluded when LLM unavailable (can't classify visual relevance)
      const appearanceFacets = permanentFacets.filter(
        (f) => f.type === 'appearance',
      );
      return appearanceFacets.map((f) => f.content);
    }
  },
};
