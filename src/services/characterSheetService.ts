/**
 * Service for generating character sheet images from story nodes.
 */
import { db } from '../config/database';
import { media, storyNodes, nodeMedia } from '../models/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { getImageProvider } from './image-generation/factory';
import type { CharacterSheetSettings } from '../types/generationSettings';
import { GENERATION_SETTINGS_SCHEMA_VERSION } from '../types/generationSettings';

interface GenerateCharacterSheetParams {
  nodeId: string;
  userId: string;
  settings: CharacterSheetSettings;
  width?: number;
  height?: number;
}

export const characterSheetService = {
  /**
   * Generate a character sheet image for a story node.
   */
  async generate({
    nodeId,
    userId,
    settings,
    width = 1024,
    height = 1024,
  }: GenerateCharacterSheetParams) {
    // Fetch node and verify ownership
    const [node] = await db
      .select()
      .from(storyNodes)
      .where(
        and(
          eq(storyNodes.id, nodeId),
          eq(storyNodes.userId, userId),
          isNull(storyNodes.deletedAt)
        )
      )
      .limit(1);

    if (!node) {
      throw new Error('Node not found');
    }

    // Build prompt from node + settings
    const prompt = this.buildPrompt(node, settings);

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
        generationSettings: {
          type: 'character_sheet',
          settings,
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
      width,
      height,
    });

    logger.info({ mediaId: newMedia.id, nodeId }, 'Character sheet generation queued');

    return newMedia;
  },

  /**
   * Build generation prompt from node description and settings.
   */
  buildPrompt(
    node: { type: string; name: string; description: string | null },
    settings: CharacterSheetSettings
  ): string {
    const parts: string[] = [];

    // Use custom description if manual edit, otherwise use node description
    const baseDescription = settings.manualEdit && settings.customDescription
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

    // Add character sheet style hints
    parts.push('Reference sheet style, clear lighting, detailed, high quality.');

    return parts.join(' ');
  },

  /**
   * Set the primary media for a node.
   */
  async setPrimaryMedia(nodeId: string, mediaId: string, userId: string) {
    // Verify node ownership
    const [node] = await db
      .select()
      .from(storyNodes)
      .where(
        and(
          eq(storyNodes.id, nodeId),
          eq(storyNodes.userId, userId),
          isNull(storyNodes.deletedAt)
        )
      )
      .limit(1);

    if (!node) {
      throw new Error('Node not found');
    }

    // Verify media exists and is associated with node
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

    // Update primary media
    await db
      .update(storyNodes)
      .set({ primaryMediaId: mediaId, updatedAt: new Date() })
      .where(eq(storyNodes.id, nodeId));

    logger.info({ nodeId, mediaId }, 'Primary media set for node');

    return { success: true };
  },

  /**
   * Get all character sheets for a node.
   */
  async getNodeMedia(nodeId: string, userId: string) {
    // Verify node ownership
    const [node] = await db
      .select()
      .from(storyNodes)
      .where(
        and(
          eq(storyNodes.id, nodeId),
          eq(storyNodes.userId, userId),
          isNull(storyNodes.deletedAt)
        )
      )
      .limit(1);

    if (!node) {
      throw new Error('Node not found');
    }

    // Get associated media
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
          isNull(media.deletedAt)
        )
      )
      .orderBy(media.createdAt);

    return {
      node,
      media: results,
      primaryMediaId: node.primaryMediaId,
    };
  },
};
