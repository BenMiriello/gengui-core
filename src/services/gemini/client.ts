/**
 * Gemini API client for story node analysis.
 * Thin wrapper handling API calls, retries, and error handling.
 */

import { getTextModelConfig } from '../../config/text-models';
import {
  batchedRelationshipConfig,
  calculateThinkingBudget,
  estimateExtractionOutputTokens,
  extractionConfig,
} from '../contextBudget';
import {
  analyzeHigherOrderPrompt,
  batchResolveEntitiesPrompt,
  detectContradictionsPrompt,
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
  stage10DetectContradictionsSchema,
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

  // Check for potential truncation indicators
  const trimmed = text.trim();
  const looksComplete = trimmed.endsWith('}') || trimmed.endsWith(']');
  const finishReason = result.candidates?.[0]?.finishReason;

  try {
    return JSON.parse(text) as T;
  } catch (parseError: any) {
    // Log detailed diagnostics for debugging
    logger.error(
      {
        operation,
        responseLength: text.length,
        responseStart: text.slice(0, 500),
        responseEnd: text.slice(-500),
        looksComplete,
        finishReason,
        parseError: parseError?.message,
      },
      `JSON parse failed for ${operation}`,
    );

    // Try to identify the specific issue
    let hint = '';
    if (!looksComplete) {
      hint = ' Response appears truncated (does not end with } or ]).';
    }
    if (finishReason && finishReason !== 'STOP') {
      hint += ` Finish reason: ${finishReason}.`;
    }

    throw new Error(`Failed to parse ${operation} response as JSON.${hint}`);
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
  /** Name of the matched registry entity (exact match required) */
  matchedName: string;
  /** Type of the matched registry entity */
  matchedType: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Merge signal for uncertain matches */
export interface MergeSignal {
  extractedEntityName: string;
  /** Name of the registry entity this might match */
  registryName: string;
  /** Type of the registry entity this might match */
  registryType: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

/** Segment input for batch extraction */
export interface SegmentInput {
  id: string;
  index: number;
  text: string;
}

/** Stage 2 extraction result with batch support and segmentId tracking */
export interface Stage2ExtractionResult {
  entities: Array<{
    name: string;
    type: StoryNodeType;
    segmentId: string;
    documentOrder?: number;
    existingMatch?: ExistingMatch;
  }>;
  facets: Array<{
    entityName: string;
    segmentId: string;
    facetType: FacetType;
    content: string;
  }>;
  mentions: Array<{
    entityName: string;
    segmentId: string;
    text: string;
  }>;
  mergeSignals?: MergeSignal[];
}

/**
 * Stage 3: Extract entities, facets, and mentions from a batch of segments.
 * Uses entity registry for LLM-first merge detection.
 * Supports multi-segment batching for efficient context window usage.
 */
export async function extractEntitiesFromBatch(
  segments: SegmentInput[],
  totalSegments: number,
  entityRegistry?: EntityRegistryEntry[],
  overlapSegmentText?: string,
  segmentSummaries?: Array<{ index: number; summary: string }>,
  documentSummary?: string,
): Promise<Stage2ExtractionResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = extractEntitiesPrompt.build({
    segments,
    totalSegments,
    entityRegistry,
    overlapSegmentText,
    segmentSummaries,
    documentSummary,
  });

  let lastError: Error | null = null;
  const segmentIndices = segments.map((s) => s.index);
  const segmentRange = segments.length > 0
    ? `${Math.min(...segmentIndices)}-${Math.max(...segmentIndices)}`
    : 'none';

  // Get model config for output limits
  const modelConfig = getTextModelConfig(extractEntitiesPrompt.model);
  const charsPerToken = modelConfig.charsPerToken;
  const maxModelOutput = modelConfig.maxOutputTokens;

  // Log input characteristics for diagnostics
  const totalInputChars = segments.reduce((sum, s) => sum + s.text.length, 0);
  const estimatedInputTokens = Math.ceil(totalInputChars / charsPerToken);
  const projectedExtractedEntities = Math.ceil(totalInputChars / 500);
  // Use single source of truth for output estimation
  const estimatedOutputTokens = estimateExtractionOutputTokens(totalInputChars);

  // Target 60% of output capacity for batch sizing (conservative)
  // Model can still use full capacity, this is just our target for batch calculator
  const totalOutputCapacity = Math.floor(maxModelOutput * 0.6);

  const thinkingBudgetResult = extractionConfig.thinkingConfig
    ? calculateThinkingBudget(
        totalOutputCapacity,
        estimatedOutputTokens,
        extractionConfig.thinkingConfig,
      )
    : {
        thinkingBudget: 0,
        maxOutputTokens: totalOutputCapacity,
        guaranteedResponseCapacity: totalOutputCapacity,
      };

  logger.info(
    {
      segmentRange,
      segmentCount: segments.length,
      totalInputChars,
      estimatedInputTokens,
      promptChars: prompt.length,
      promptTokens: Math.ceil(prompt.length / charsPerToken),
      registryEntitiesIncluded: entityRegistry?.length ?? 0,
      projectedExtractedEntities,
      estimatedOutputTokens,
      totalOutputCapacity,
      thinkingBudget: thinkingBudgetResult.thinkingBudget,
      guaranteedResponseCapacity: thinkingBudgetResult.guaranteedResponseCapacity,
      maxModelOutput,
    },
    'Stage 3: Starting batch extraction',
  );

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    try {
      const result = await client.models.generateContent({
        model: extractEntitiesPrompt.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: stage1ExtractEntitiesSchema,
          httpOptions: { timeout: 300000 },
        },
      });
      const elapsed = Date.now() - startTime;

      const responseLength = result.text?.length ?? 0;
      const parsed = parseResponse<Stage2ExtractionResult>(
        result,
        'extractEntitiesFromBatch',
      );

      const matchCount = parsed.entities.filter((e) => e.existingMatch).length;
      const signalCount = parsed.mergeSignals?.length ?? 0;

      logger.info(
        {
          segmentRange,
          segmentCount: segments.length,
          entitiesCount: parsed.entities.length,
          facetsCount: parsed.facets.length,
          mentionsCount: parsed.mentions.length,
          matchCount,
          signalCount,
          elapsedMs: elapsed,
          responseLength,
        },
        'Stage 3: Entities extracted from batch with merge detection',
      );

      return parsed;
    } catch (error: any) {
      lastError = error;
      logger.warn(
        {
          segmentIndices,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          error: error?.message,
          elapsedMs: Date.now() - startTime,
        },
        'Stage 3 batch extraction attempt failed, retrying',
      );

      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS[attempt]),
        );
      }
    }
  }

  throw handleApiError(lastError, 'Stage 3 batch extraction');
}

/**
 * Stage 3: Extract entities from a single segment.
 * Convenience wrapper around extractEntitiesFromBatch for single-segment use.
 */
export async function extractEntitiesFromSegment(
  segmentId: string,
  segmentText: string,
  segmentIndex: number,
  totalSegments: number,
  entityRegistry?: EntityRegistryEntry[],
  previousSegmentText?: string,
): Promise<Stage2ExtractionResult> {
  return extractEntitiesFromBatch(
    [{ id: segmentId, index: segmentIndex, text: segmentText }],
    totalSegments,
    entityRegistry,
    previousSegmentText,
  );
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
 * Stage 5: Resolve a single extracted entity against candidates.
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
      'Stage 5: Entity resolution completed',
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
 * Stage 5: Batch resolve multiple entities.
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
      'Stage 5: Batch entity resolution completed',
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
 * Stage 6: Extract relationships between entities in a segment.
 */
export async function extractRelationshipsFromSegment(
  segmentText: string,
  segmentIndex: number,
  resolvedEntities: Array<{
    id: string;
    name: string;
    type: string;
    keyFacets: string[];
    aliases?: string[];
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
      'Relationships extracted from segment',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 4 relationship extraction');
  }
}

/** Batched relationship extraction result (with segmentId attribution) */
export interface Stage4BatchRelationshipsResult {
  relationships: Array<{
    fromId: string;
    toId: string;
    edgeType: string;
    description: string;
    strength?: number;
    segmentId: string; // NEW: track which segment this relationship came from
  }>;
}

/**
 * Stage 6 (batched): Extract relationships from multiple segments in one LLM call.
 * Reduces API calls and improves throughput.
 */
export async function extractRelationshipsFromBatch(
  segments: Array<{
    id: string;
    index: number;
    text: string;
    entities: Array<{
      id: string;
      name: string;
      type: string;
      keyFacets: string[];
      aliases?: string[];
    }>;
  }>,
  documentSummary?: string,
): Promise<Stage4BatchRelationshipsResult> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  // Build multi-segment prompt
  const segmentsText = segments
    .map((seg) => {
      const entitiesSection = seg.entities
        .map((e) => {
          let entry = `[${e.id}] ${e.type.toUpperCase()}: "${e.name}"`;
          if (e.aliases && e.aliases.length > 0) {
            entry += ` (also: ${e.aliases.join(', ')})`;
          }
          entry += ` - ${e.keyFacets.join(', ') || 'no facets'}`;
          return entry;
        })
        .join('\n');

      return `### SEGMENT ${seg.index + 1} [id: ${seg.id}]
"""
${seg.text}
"""

ENTITIES IN THIS SEGMENT:
${entitiesSection}`;
    })
    .join('\n\n');

  const documentContext = documentSummary
    ? `## DOCUMENT CONTEXT\n${documentSummary}\n\n`
    : '';

  const prompt = `${documentContext}Extract relationships between entities in these narrative segments.
Focus on relationships EVIDENCED in the segment text.

${segmentsText}

## OUTPUT FORMAT
\`\`\`json
{
  "relationships": [
    {
      "fromId": "entity-uuid",
      "toId": "entity-uuid",
      "segmentId": "segment-uuid",
      "edgeType": "RELATIONSHIP_TYPE",
      "description": "Brief explanation",
      "strength": 0.8
    }
  ]
}
\`\`\`

EDGE TYPES:

**Layer 2 - Causal/Temporal (MUST include strength 0-1):**
- CAUSES: A directly causes B (necessary and sufficient)
- ENABLES: A makes B possible but doesn't guarantee it
- PREVENTS: A blocks B from occurring
- HAPPENS_BEFORE: Temporal only (use sparingly - text position often suffices)

**Layer 3 - Structural/Relational:**
- PARTICIPATES_IN: Agent involved in event
- LOCATED_AT: Entity exists/occurs at location
- PART_OF: Component of containing entity (chapter of book)
- MEMBER_OF: Belongs to group while retaining identity
- POSSESSES: Ownership or control
- CONNECTED_TO: Social/professional connection between agents
- OPPOSES: Conflict, antagonism, opposition
- ABOUT: Entity relates to abstract concept/theme
- RELATED_TO: Fallback (use sparingly, <5% of edges)

RULES:
1. Use entity IDs from the lists above - not names
2. Only extract relationships EVIDENCED in each segment text
3. For causal edges (CAUSES, ENABLES, PREVENTS), include strength 0-1
4. Prefer specific edge types over RELATED_TO
5. Description should be 3-10 words explaining the relationship
6. IMPORTANT: Set segmentId to the segment where the relationship is evidenced
7. Extract ALL relationships evidenced in each segment`;

  // Validate output budget before sending batch
  const modelConfig = getTextModelConfig('gemini-2.5-flash');
  const charsPerToken = modelConfig.charsPerToken;
  const outputUtilization = modelConfig.outputUtilization ?? 0.6;
  const maxModelOutput = modelConfig.maxOutputTokens;
  const totalOutputCapacity = Math.floor(maxModelOutput * outputUtilization);

  // Estimate output for this batch
  const estimatedOutputTokens = batchedRelationshipConfig.estimateOutputReserve(
    segments,
    charsPerToken,
  );

  // Validate batch fits
  if (estimatedOutputTokens > totalOutputCapacity) {
    logger.error(
      {
        segmentCount: segments.length,
        estimatedOutputTokens,
        totalOutputCapacity,
        exceedsBy: estimatedOutputTokens - totalOutputCapacity,
      },
      'Stage 6: Batch exceeds output capacity - calculator error',
    );

    throw new Error(
      `Batch output (${estimatedOutputTokens} tokens) exceeds capacity (${totalOutputCapacity} tokens). ` +
        `This indicates a bug in the batch calculator.`,
    );
  }

  logger.info(
    {
      segmentCount: segments.length,
      estimatedOutputTokens,
      totalOutputCapacity,
      utilizationPercent: ((estimatedOutputTokens / totalOutputCapacity) * 100).toFixed(1),
    },
    'Stage 6: Output budget validated',
  );

  try {
    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage4ExtractRelationshipsSchema,
      },
    });

    const parsed = parseResponse<Stage4RelationshipsResult>(
      result,
      'extractRelationshipsFromBatch',
    );

    // Add segmentId attribution (fallback to first segment if not provided)
    const relationships: Stage4BatchRelationshipsResult['relationships'] = [];
    for (const rel of parsed.relationships) {
      // Check if relationship already has segmentId in description or elsewhere
      // If not, we can't reliably attribute it - log warning and skip
      if (!(rel as any).segmentId) {
        logger.warn(
          { fromId: rel.fromId, toId: rel.toId, edgeType: rel.edgeType },
          'Relationship missing segmentId attribution',
        );
        // Default to first segment as fallback
        relationships.push({
          ...rel,
          segmentId: segments[0].id,
        });
      } else {
        relationships.push(rel as any);
      }
    }

    const segmentIndices = segments.map((s) => s.index);
    const segmentRange = segments.length > 0
      ? `${Math.min(...segmentIndices)}-${Math.max(...segmentIndices)}`
      : 'none';

    logger.info(
      {
        segmentRange,
        segmentCount: segments.length,
        relationshipsCount: relationships.length,
      },
      'Stage 6: Relationships extracted from batch',
    );

    return { relationships };
  } catch (error) {
    throw handleApiError(error, 'Stage 6 batched relationship extraction');
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
 * Stage 8: Analyze higher-order narrative structure.
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
      'Stage 8: Higher-order analysis completed',
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
 * Stage 8: Refine algorithmically detected threads.
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
      'Stage 8: Thread refinement completed',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 5 thread refinement');
  }
}

/** Stage 10 contradiction detection result */
export interface Stage10ContradictionResult {
  facetIndexA: number;
  facetIndexB: number;
  classificationType: 'true_inconsistency' | 'temporal_change' | 'arc_divergence';
  reasoning: string;
}

/**
 * Stage 10: Detect contradictions in a batch of facets for a single entity.
 * Analyzes all facets of the same type at once for efficiency.
 */
export async function detectContradictionsInBatch(
  entityName: string,
  facetType: FacetType,
  facets: Array<{ content: string }>,
): Promise<Stage10ContradictionResult[]> {
  const client = await getGeminiClient();
  if (!client) {
    throw new Error(
      'Gemini API client not initialized - GEMINI_API_KEY missing',
    );
  }

  const prompt = detectContradictionsPrompt.build({
    entityName,
    facetType,
    facets,
  });

  try {
    const result = await client.models.generateContent({
      model: detectContradictionsPrompt.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: stage10DetectContradictionsSchema,
      },
    });

    const parsed = parseResponse<Stage10ContradictionResult[]>(
      result,
      'detectContradictionsInBatch',
    );

    logger.info(
      {
        entityName,
        facetType,
        facetCount: facets.length,
        contradictionsFound: parsed.length,
      },
      'Stage 10: Contradiction detection completed',
    );

    return parsed;
  } catch (error) {
    throw handleApiError(error, 'Stage 10 contradiction detection');
  }
}
