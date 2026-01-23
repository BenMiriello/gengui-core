/**
 * Character reference image fetching and detection
 */

import { db } from '../../config/database';
import { storyNodes, media } from '../../models/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getGeminiClient } from '../gemini';
import { s3 } from '../s3';
import type { ReferenceImage } from '../image-generation/types';
import type { CharacterReferences } from './promptBuilder';

export async function fetchCharacterReferenceImages(
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
    targetNodeIds = await detectCharactersInText(selectedText, allCharacterNodes);
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

export async function detectCharactersInText(
  selectedText: string,
  characterNodes: Array<{ id: string; name: string; description: string | null }>
): Promise<string[]> {
  const client = await getGeminiClient();
  if (!client) {
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
    const result = await client.models.generateContent({
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
