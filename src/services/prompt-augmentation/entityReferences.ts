/**
 * Entity reference data fetching and detection for all entity types
 * Supports characters, locations, and objects (type "other" in FalkorDB)
 */

import { inArray } from 'drizzle-orm';
import { db } from '../../config/database';
import { media } from '../../models/schema';
import { logger } from '../../utils/logger';
import { generateEmbedding } from '../embeddings';
import { graphService } from '../graph/graph.service';
import type { ReferenceImage } from '../image-generation/types';
import { s3 } from '../s3';
import type { EntityDescription, EntityReferences } from './promptBuilder';

const ENTITY_TYPES = ['character', 'location', 'other'] as const;

export interface EntityReferenceData {
  images: ReferenceImage[];
  descriptions: EntityDescription[];
}

export async function fetchEntityReferenceData(
  documentId: string,
  userId: string,
  entityRefs: EntityReferences,
  selectedText: string
): Promise<EntityReferenceData> {
  const allNodes = await graphService.getStoryNodesForDocument(documentId, userId);
  const allEntityNodes = allNodes.filter((n) =>
    ENTITY_TYPES.includes(n.type as (typeof ENTITY_TYPES)[number])
  );

  if (allEntityNodes.length === 0) {
    logger.info({ documentId }, 'No entity nodes found for document');
    return { images: [], descriptions: [] };
  }

  let targetNodeIds: string[];

  if (entityRefs.mode === 'manual' && entityRefs.selectedNodeIds) {
    targetNodeIds = entityRefs.selectedNodeIds;
  } else {
    targetNodeIds = await detectEntitiesInText(selectedText, allEntityNodes, documentId, userId);
  }

  if (targetNodeIds.length === 0) {
    logger.info({ documentId, mode: entityRefs.mode }, 'No entity nodes selected for references');
    return { images: [], descriptions: [] };
  }

  const selectedNodes = allEntityNodes.filter((node) => targetNodeIds.includes(node.id));

  const result: EntityReferenceData = {
    images: [],
    descriptions: [],
  };

  if (entityRefs.useImages) {
    result.images = await fetchEntityImages(selectedNodes);
  }

  if (entityRefs.useDescriptions) {
    result.descriptions = extractEntityDescriptions(selectedNodes);
  }

  return result;
}

async function fetchEntityImages(
  nodes: Array<{ id: string; name: string; type: string; primaryMediaId: string | null }>
): Promise<ReferenceImage[]> {
  const nodesWithMedia = nodes.filter((node) => node.primaryMediaId);

  if (nodesWithMedia.length === 0) {
    logger.info('Selected entity nodes have no primary media set');
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

function extractEntityDescriptions(
  nodes: Array<{ id: string; name: string; type: string; description: string | null }>
): EntityDescription[] {
  return nodes
    .filter((node) => node.description?.trim())
    .map((node) => ({
      type: mapNodeTypeToEntityType(node.type),
      name: node.name,
      description: node.description!.trim(),
    }));
}

function mapNodeTypeToEntityType(nodeType: string): 'character' | 'location' | 'object' {
  if (nodeType === 'character') return 'character';
  if (nodeType === 'location') return 'location';
  return 'object';
}

export async function detectEntitiesInText(
  selectedText: string,
  entityNodes: Array<{ id: string; name: string; description: string | null }>,
  documentId: string,
  userId: string
): Promise<string[]> {
  if (entityNodes.length === 0) {
    return [];
  }

  try {
    const queryEmbedding = await generateEmbedding(selectedText);
    const similar = await graphService.findSimilarNodes(queryEmbedding, documentId, userId, 10);
    const entityIds = new Set(entityNodes.map((e) => e.id));
    const result = similar.filter((n) => entityIds.has(n.id) && n.score > 0.3).map((n) => n.id);

    logger.info(
      { detectedCount: result.length, detectedEntities: result },
      'Entities detected in text via embeddings'
    );

    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to detect entities via embeddings');
    return [];
  }
}

/** @deprecated Use fetchEntityReferenceData instead */
export async function fetchCharacterReferenceImages(
  documentId: string,
  userId: string,
  characterRefs: { mode: 'auto' | 'manual'; selectedNodeIds?: string[] },
  selectedText: string
): Promise<ReferenceImage[]> {
  const entityRefs: EntityReferences = {
    ...characterRefs,
    useImages: true,
    useDescriptions: false,
  };

  const result = await fetchEntityReferenceData(documentId, userId, entityRefs, selectedText);
  return result.images;
}
