/**
 * Service for generating character sheet images from story nodes.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database';
import { getDimensionsForAspectRatio, getModelIdForProvider } from '../config/models';
import { media, nodeMedia } from '../models/schema';
import type { AspectRatio, CharacterSheetSettings } from '../types/generationSettings';
import { GENERATION_SETTINGS_SCHEMA_VERSION } from '../types/generationSettings';
import { logger } from '../utils/logger';
import { graphService } from './graph/graph.service';
import { getImageProvider, getImageProviderName } from './image-generation/factory';

interface GenerateCharacterSheetParams {
  nodeId: string;
  userId: string;
  settings: CharacterSheetSettings;
  aspectRatio?: AspectRatio;
  stylePreset?: string | null;
  stylePrompt?: string | null;
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
  }: GenerateCharacterSheetParams) {
    // Fetch node and verify ownership from FalkorDB
    const node = await graphService.getStoryNodeById(nodeId, userId);

    if (!node) {
      throw new Error('Node not found');
    }

    // Determine aspect ratio: explicit param > settings > default based on node type
    const defaultAR: AspectRatio =
      node.type === 'character' ? 'portrait' : node.type === 'location' ? 'landscape' : 'square';
    const finalAR = aspectRatio ?? settings.aspectRatio ?? defaultAR;

    // Get dimensions for the current provider
    const providerName = await getImageProviderName();
    const modelId = getModelIdForProvider(providerName);
    const { width, height } = getDimensionsForAspectRatio(finalAR, modelId);

    // Use provided style or fall back to node's style
    const finalStylePreset = stylePreset !== undefined ? stylePreset : node.stylePreset;
    const finalStylePrompt = stylePrompt !== undefined ? stylePrompt : node.stylePrompt;

    // Build prompt from node + settings + style
    const prompt = this.buildPrompt(node, settings, finalStylePrompt);

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
        },
        generationSettingsSchemaVersion: GENERATION_SETTINGS_SCHEMA_VERSION,
      })
      .returning();

    // Create node_media association
    await db.insert(nodeMedia).values({
      nodeId,
      mediaId: newMedia.id,
    });

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
      'Character sheet generation queued'
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
    stylePrompt?: string | null
  ): string {
    const parts: string[] = [];

    // STYLE FIRST - Imagen weights the beginning of prompts more heavily
    if (stylePrompt) {
      parts.push(stylePrompt);
    }

    // Use custom description if manual edit, otherwise use node description
    const baseDescription =
      settings.manualEdit && settings.customDescription
        ? settings.customDescription
        : node.description || node.name;

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
      } else if (settings.perspective === 'custom' && settings.perspectiveCustom) {
        parts.push(settings.perspectiveCustom);
      }
    }

    // Add background
    if (settings.background === 'white') {
      parts.push('Plain white background, no other elements, isolated subject.');
    } else if (settings.background === 'black') {
      parts.push('Plain black background, no other elements, isolated subject.');
    } else if (settings.background === 'transparent') {
      parts.push('Transparent background, isolated subject, no environment.');
    } else if (settings.background === 'custom' && settings.backgroundCustom) {
      parts.push(`Background: ${settings.backgroundCustom}`);
    }

    // Quality hints - only add generic ones if no style prompt provided
    if (stylePrompt) {
      parts.push('Clear lighting, detailed, high quality.');
    } else {
      parts.push('Reference sheet style, clear lighting, detailed, high quality.');
    }

    return parts.join(' ');
  },

  /**
   * Set the primary media for a node.
   */
  async setPrimaryMedia(nodeId: string, mediaId: string, userId: string) {
    // Verify node ownership from FalkorDB
    const node = await graphService.getStoryNodeById(nodeId, userId);

    if (!node) {
      throw new Error('Node not found');
    }

    // Verify media exists and is associated with node (still in Postgres)
    const [association] = await db
      .select()
      .from(nodeMedia)
      .where(
        and(
          eq(nodeMedia.nodeId, nodeId),
          eq(nodeMedia.mediaId, mediaId),
          isNull(nodeMedia.deletedAt)
        )
      )
      .limit(1);

    if (!association) {
      throw new Error('Media is not associated with this node');
    }

    // Update primary media in FalkorDB
    await graphService.updateStoryNodePrimaryMedia(nodeId, mediaId);

    logger.info({ nodeId, mediaId }, 'Primary media set for node');

    return { success: true };
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
        and(eq(nodeMedia.nodeId, nodeId), isNull(nodeMedia.deletedAt), isNull(media.deletedAt))
      )
      .orderBy(media.createdAt);

    return {
      node,
      media: results,
      primaryMediaId: node.primaryMediaId,
    };
  },
};
