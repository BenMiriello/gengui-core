/**
 * Gemini API client for story node analysis.
 * Thin wrapper handling API calls, retries, and error handling.
 */

import {
  analyzeHigherOrderPrompt,
  batchResolveEntitiesPrompt,
  extractCrossSegmentRelationshipsPrompt,
  extractEntitiesPrompt,
  extractRelationshipsPrompt,
  refineThreadsPrompt,
  resolveEntityPrompt,
  updateNodesPrompt,
} from '../../prompts/storyNodes';
import type {
  ExistingNode,
  FacetType,
  NodeUpdatesResult,
  StoryNodeType,
} from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import { getGeminiClient } from './core';
import {
  stage1ExtractEntitiesSchema,
  stage3BatchResolveSchema,
  stage3ResolveEntitySchema,
  stage4ExtractRelationshipsSchema,
  stage5HigherOrderSchema,
  stage5RefineThreadsSchema,
  updateNodesResponseSchema,
} from './schemas/storyNodes';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * Analyze document for incremental changes to existing nodes.
 * Uses retry logic with progressive backoff.
 */
export async function updateNodes(
  content: string,
  existingNodes: ExistingNode[],
): Promise<NodeUpdatesResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = updateNodesPrompt.build({ content, existingNodes });
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await client.models.generateContent({
        model: updateNodesPrompt.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: updateNodesResponseSchema,
        },
      });

      const parsed = parseResponse<NodeUpdatesResult>(result, 'updateNodes');
      validateUpdateResponse(parsed, existingNodes);

      logger.info(
        {
          addCount: parsed.add.length,
          updateCount: parsed.update.length,
          deleteCount: parsed.delete.length,
        },
        'Node updates parsed successfully',
      );

      return parsed;
    } catch (error: any) {
      lastError = error;
      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          error: error?.message,
        },
        'updateNodes attempt failed',
      );

      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS[attempt]),
        );
      }
    }
  }

  throw lastError || new Error('updateNodes failed after retries');
}

/**
 * Parse and validate Gemini API response.
 */
function parseResponse<T>(result: any, operation: string): T {
  if (!result?.candidates?.length) {
    const blockReason = result?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Content blocked: ${blockReason}`);
    }
    throw new Error('Empty response from API');
  }

  const text = result.text;
  if (!text?.trim()) {
    throw new Error('Empty response text');
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse ${operation} response as JSON`);
  }
}

/**
 * Validate that update response references valid node IDs.
 */
function validateUpdateResponse(
  parsed: NodeUpdatesResult,
  existingNodes: ExistingNode[],
): void {
  if (
    !Array.isArray(parsed.add) ||
    !Array.isArray(parsed.update) ||
    !Array.isArray(parsed.delete) ||
    !parsed.connectionUpdates
  ) {
    throw new Error('Malformed response structure');
  }

  const existingIds = new Set(existingNodes.map((n) => n.id));

  for (const update of parsed.update) {
    if (!update.id || !existingIds.has(update.id)) {
      logger.error(
        { invalidId: update.id },
        'Update references non-existent node ID',
      );
      throw new Error(`Update references invalid node ID: ${update.id}`);
    }
  }

  for (const deleteId of parsed.delete) {
    if (!existingIds.has(deleteId)) {
      logger.error(
        { invalidId: deleteId },
        'Delete references non-existent node ID',
      );
      throw new Error(`Delete references invalid node ID: ${deleteId}`);
    }
  }
}

/**
 * Convert API errors to user-friendly messages.
 */
function handleApiError(error: any, operation: string): Error {
  const message = error?.message || '';

  if (message.includes('quota')) {
    return new Error('API quota exceeded. Please try again later.');
  }
  if (message.includes('rate limit')) {
    return new Error(
      'Rate limit exceeded. Please wait a moment and try again.',
    );
  }
  if (message.includes('404')) {
    return new Error(
      'Analysis model not found. Check GEMINI_API_KEY and model configuration.',
    );
  }
  if (message.includes('blocked') || message.includes('inappropriate')) {
    return error;
  }

  return new Error(
    `${operation} failed: ${message || 'Unknown error'}. Please try again.`,
  );
}

// =============================================================================
// Multi-Stage Pipeline Functions
// =============================================================================

/** Entity registry entry for Stage 1 extraction */
export interface EntityRegistryEntry {
  registryIndex: number;
  id: string;
  name: string;
  type: string;
  aliases?: string[];
  summary?: string;
}


/** Existing match from LLM merge detection */
export interface ExistingMatch {
  registryIndex: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Merge signal for uncertain matches */
export interface MergeSignal {
  extractedEntityName: string;
  registryIndex: number;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

/** Stage 1 extraction result with LLM-first merge detection */
export interface Stage1ExtractionResult {
  entities: Array<{
    name: string;
    type: StoryNodeType;
    documentOrder?: number;
    existingMatch?: ExistingMatch;
  }>;
  facets: Array<{ entityName: string; facetType: FacetType; content: string }>;
  mentions: Array<{ entityName: string; text: string }>;
  mergeSignals?: MergeSignal[];
}

/**
 * Stage 1: Extract entities, facets, and mentions from a single segment.
 * Uses entity registry for LLM-first merge detection.
 */
export async function extractEntitiesFromSegment(
  segmentText: string,
  segmentIndex: number,
  totalSegments: number,
  entityRegistry?: EntityRegistryEntry[],
  previousSegmentText?: string,
): Promise<Stage1ExtractionResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = extractEntitiesPrompt.build({
    segmentText,
    segmentIndex,
    totalSegments,
    entityRegistry,
    previousSegmentText,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await client.models.generateContent({
        model: extractEntitiesPrompt.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: stage1ExtractEntitiesSchema,
        },
      });

      const parsed = parseResponse<Stage1ExtractionResult>(
        result,
        'extractEntitiesFromSegment',
      );

      const matchCount = parsed.entities.filter((e) => e.existingMatch).length;
      const signalCount = parsed.mergeSignals?.length ?? 0;

      logger.info(
        {
          segmentIndex,
          entitiesCount: parsed.entities.length,
          facetsCount: parsed.facets.length,
          mentionsCount: parsed.mentions.length,
          matchCount,
          signalCount,
        },
        'Stage 1: Entities extracted with merge detection',
      );

      return parsed;
    } catch (error: any) {
      lastError = error;
      logger.warn(
        {
          segmentIndex,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          error: error?.message,
        },
        'Stage 1 extraction attempt failed, retrying',
      );

      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS[attempt]),
        );
      }
    }
  }

  throw handleApiError(lastError, 'Stage 1 extraction');
}

/** Stage 3 resolution input */
interface Stage3ResolutionInput {
  extractedEntity: {
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentions: Array<{ text: string }>;
  };
  candidates: Array<{
    id: string;
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentionCount: number;
    similarityScore: number;
  }>;
  documentContext?: string;
}

/** Stage 3 resolution result */
export interface Stage3ResolutionResult {
  decision: 'MERGE' | 'UPDATE' | 'ADD_FACET' | 'NEW';
  targetEntityId?: string;
  newFacets?: Array<{ type: FacetType; content: string }>;
  reason: string;
}

/**
 * Stage 3: Resolve a single extracted entity against candidates.
 */
export async function resolveEntity(
  input: Stage3ResolutionInput,
): Promise<Stage3ResolutionResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = resolveEntityPrompt.build(input);

  try {
    const result = await client.models.generateContent({
      model: resolveEntityPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage3ResolveEntitySchema,
      },
    });

    const parsed = parseResponse<Stage3ResolutionResult>(
      result,
      'resolveEntity',
    );

    logger.info(
      {
        entityName: input.extractedEntity.name,
        decision: parsed.decision,
        targetId: parsed.targetEntityId,
      },
      'Stage 3: Entity resolution completed',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 3 resolution');
  }
}

/** Stage 3 batch resolution result */
export interface Stage3BatchResolutionResult {
  resolutions: Array<{
    extractedIndex: number;
    decision: 'MERGE' | 'UPDATE' | 'ADD_FACET' | 'NEW';
    targetEntityId?: string;
    newFacets?: Array<{ type: FacetType; content: string }>;
    reason: string;
  }>;
}

/**
 * Stage 3: Batch resolve multiple entities.
 */
export async function batchResolveEntities(
  extractedEntities: Array<{
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentions: Array<{ text: string }>;
    candidateIds: string[];
  }>,
  allCandidates: Array<{
    id: string;
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentionCount: number;
  }>,
  documentContext?: string,
): Promise<Stage3BatchResolutionResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = batchResolveEntitiesPrompt.build({
    extractedEntities,
    allCandidates,
    documentContext,
  });

  try {
    const result = await client.models.generateContent({
      model: batchResolveEntitiesPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage3BatchResolveSchema,
      },
    });

    const parsed = parseResponse<Stage3BatchResolutionResult>(
      result,
      'batchResolveEntities',
    );

    logger.info(
      {
        entitiesCount: extractedEntities.length,
        resolutionsCount: parsed.resolutions.length,
      },
      'Stage 3: Batch entity resolution completed',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 3 batch resolution');
  }
}

/** Stage 4 relationship extraction result */
export interface Stage4RelationshipsResult {
  relationships: Array<{
    fromId: string;
    toId: string;
    edgeType: string;
    description: string;
    strength?: number;
  }>;
}

/**
 * Stage 4: Extract relationships between entities in a segment.
 */
export async function extractRelationshipsFromSegment(
  segmentText: string,
  segmentIndex: number,
  resolvedEntities: Array<{
    id: string;
    name: string;
    type: string;
    keyFacets: string[];
  }>,
): Promise<Stage4RelationshipsResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = extractRelationshipsPrompt.build({
    segmentText,
    segmentIndex,
    resolvedEntities,
  });

  try {
    const result = await client.models.generateContent({
      model: extractRelationshipsPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage4ExtractRelationshipsSchema,
      },
    });

    const parsed = parseResponse<Stage4RelationshipsResult>(
      result,
      'extractRelationshipsFromSegment',
    );

    logger.info(
      {
        segmentIndex,
        relationshipsCount: parsed.relationships.length,
      },
      'Stage 4: Relationships extracted from segment',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 4 relationship extraction');
  }
}

/**
 * Stage 4b: Extract cross-segment relationships.
 */
export async function extractCrossSegmentRelationships(
  documentSummary: string | undefined,
  allEntities: Array<{
    id: string;
    name: string;
    type: string;
    segmentIds: string[];
    keyFacets: string[];
  }>,
  existingRelationships: Array<{
    fromId: string;
    toId: string;
    edgeType: string;
  }>,
): Promise<Stage4RelationshipsResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = extractCrossSegmentRelationshipsPrompt.build({
    documentSummary,
    allEntities,
    existingRelationships,
  });

  try {
    const result = await client.models.generateContent({
      model: extractCrossSegmentRelationshipsPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage4ExtractRelationshipsSchema,
      },
    });

    const parsed = parseResponse<Stage4RelationshipsResult>(
      result,
      'extractCrossSegmentRelationships',
    );

    logger.info(
      {
        entitiesCount: allEntities.length,
        newRelationshipsCount: parsed.relationships.length,
      },
      'Stage 4b: Cross-segment relationships extracted',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 4b cross-segment relationships');
  }
}

/** Stage 5 higher-order analysis result */
export interface Stage5HigherOrderResult {
  narrativeThreads: Array<{
    name: string;
    isPrimary: boolean;
    eventIds: string[];
    description?: string;
  }>;
  /** Flattened arc phases - grouped by characterId + phaseIndex */
  arcPhases: Array<{
    characterId: string;
    phaseIndex: number;
    phaseName: string;
    arcType: 'transformation' | 'growth' | 'fall' | 'revelation' | 'static';
    triggerEventId: string | null;
    stateFacets: string[];
  }>;
}

/**
 * Stage 5: Analyze higher-order narrative structure.
 */
export async function analyzeHigherOrder(
  events: Array<{
    id: string;
    name: string;
    documentOrder: number;
    connectedCharacterIds: string[];
    causalEdges: Array<{
      type: 'CAUSES' | 'ENABLES' | 'PREVENTS';
      targetId: string;
      strength: number;
    }>;
  }>,
  characters: Array<{
    id: string;
    name: string;
    participatesInEventIds: string[];
    stateFacetsBySegment: Array<{
      segmentIndex: number;
      states: string[];
    }>;
  }>,
  threadCandidates: Array<{
    eventIds: string[];
    characterIds: string[];
  }>,
  documentSummary?: string,
): Promise<Stage5HigherOrderResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = analyzeHigherOrderPrompt.build({
    events,
    characters,
    threadCandidates,
    documentSummary,
  });

  try {
    const result = await client.models.generateContent({
      model: analyzeHigherOrderPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage5HigherOrderSchema,
      },
    });

    const parsed = parseResponse<Stage5HigherOrderResult>(
      result,
      'analyzeHigherOrder',
    );

    logger.info(
      {
        threadsCount: parsed.narrativeThreads.length,
        arcPhasesCount: parsed.arcPhases?.length || 0,
      },
      'Stage 5: Higher-order analysis completed',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 5 higher-order analysis');
  }
}

/** Stage 5 thread refinement result */
export interface Stage5ThreadRefinementResult {
  threads: Array<{
    index: number;
    name: string;
    isPrimary: boolean;
    description: string;
  }>;
}

/**
 * Stage 5: Refine algorithmically detected threads.
 */
export async function refineThreads(
  algorithmicThreads: Array<{
    eventIds: string[];
    eventNames: string[];
  }>,
  documentTitle?: string,
): Promise<Stage5ThreadRefinementResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = refineThreadsPrompt.build({
    algorithmicThreads,
    documentTitle,
  });

  try {
    const result = await client.models.generateContent({
      model: refineThreadsPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage5RefineThreadsSchema,
      },
    });

    const parsed = parseResponse<Stage5ThreadRefinementResult>(
      result,
      'refineThreads',
    );

    logger.info(
      {
        inputThreads: algorithmicThreads.length,
        refinedThreads: parsed.threads.length,
      },
      'Stage 5: Thread refinement completed',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 5 thread refinement');
  }
}
