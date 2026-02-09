/**
 * Character reference image fetching and detection
 */

import { inArray } from 'drizzle-orm';
import { db } from '../../config/database';
import { media } from '../../models/schema';
import { logger } from '../../utils/logger';
import { generateEmbedding } from '../embeddings';
import { graphService } from '../graph/graph.service';
import type { ReferenceImage } from '../image-generation/types';
import { s3 } from '../s3';
import type { CharacterReferences } from './promptBuilder';

export async function fetchCharacterReferenceImages(
  documentId: string,
  userId: string,
  characterRefs: CharacterReferences,
  selectedText: string
): Promise<ReferenceImage[]> {
  const allNodes = await graphService.getStoryNodesForDocument(documentId, userId);
  const allCharacterNodes = allNodes.filter((n) => n.type === 'character');

  if (allCharacterNodes.length === 0) {
    logger.info({ documentId }, 'No character nodes found for document');
    return [];
  }

  let targetNodeIds: string[];

  if (characterRefs.mode === 'manual' && characterRefs.selectedNodeIds) {
    targetNodeIds = characterRefs.selectedNodeIds;
  } else {
    targetNodeIds = await detectCharactersInText(
      selectedText,
      allCharacterNodes,
      documentId,
      userId
    );
  }

  if (targetNodeIds.length === 0) {
    logger.info(
      { documentId, mode: characterRefs.mode },
      'No character nodes selected for references'
    );
    return [];
  }

  const nodesWithMedia = allCharacterNodes.filter(
    (node) => targetNodeIds.includes(node.id) && node.primaryMediaId
  );

  if (nodesWithMedia.length === 0) {
    logger.info(
      { documentId, targetNodeIds },
      'Selected character nodes have no primary media set'
    );
    return [];
  }

  const mediaIds = nodesWithMedia.map((n) => n.primaryMediaId!);
  const mediaRecords = await db.select().from(media).where(inArray(media.id, mediaIds));

  const mediaMap = new Map(mediaRecords.map((m) => [m.id, m]));

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
    }
  }

  if (referenceImages.length > 5) {
    logger.warn({ count: referenceImages.length }, 'Limiting reference images to 5 for Gemini API');
    return referenceImages.slice(0, 5);
  }

  return referenceImages;
}

export async function detectCharactersInText(
  selectedText: string,
  characterNodes: Array<{ id: string; name: string; description: string | null }>,
  documentId: string,
  userId: string
): Promise<string[]> {
  if (characterNodes.length === 0) {
    return [];
  }

  try {
    const queryEmbedding = await generateEmbedding(selectedText);
    const similar = await graphService.findSimilarNodes(queryEmbedding, documentId, userId, 10);
    const characterIds = new Set(characterNodes.map((c) => c.id));
    const result = similar.filter((n) => characterIds.has(n.id) && n.score > 0.3).map((n) => n.id);

    logger.info(
      { detectedCount: result.length, detectedCharacters: result },
      'Characters detected in text via embeddings'
    );

    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to detect characters via embeddings');
    return [];
  }
}
