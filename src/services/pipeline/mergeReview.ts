/**
 * Merge Signal Disambiguation Pass
 *
 * After Stage 3 extraction completes, accumulated merge signals are reviewed here.
 * Signals where the LLM was uncertain whether an extracted entity matches an existing
 * registry entity are grouped, classified, and acted on:
 *
 *   high-confidence (3+ independent segments agree): auto-merge logged, queued for execution
 *   medium-confidence: LLM disambiguation call with both entities' facets and evidence
 *   uncertain LLM result: routed to review queue as merge_suggestion
 *   low-confidence: skipped (not worth LLM cost)
 *
 * True graph merges (moving mentions + facets) are not yet implemented in graph.service.
 * High-confidence decisions are recorded in MergeAction with applied=false until that
 * infrastructure exists.
 */

import { logger } from '../../utils/logger';
import { trackedAI } from '../ai';
import type { MergeSignal } from '../gemini/client';
import { GeminiType, getGeminiClient } from '../gemini/core';

// ─── Public types ────────────────────────────────────────────────────────────

export interface AccumulatedMergeSignalWithContext extends MergeSignal {
  segmentIndex: number;
  extractedEntityId?: string;
}

export interface MergeDisambiguationInput {
  documentId: string;
  userId: string;
  /** All signals accumulated during Stage 3 */
  mergeSignals: AccumulatedMergeSignalWithContext[];
  /** Maps entity name → entity ID, built during Stage 3 */
  entityIdByName: Map<string, string>;
  /** Maps entity ID → runtime registry entry (name, facets, aliases, etc.) */
  entityRegistryById: Map<string, RuntimeEntitySummary>;
}

export interface RuntimeEntitySummary {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  facets: Array<{ type: string; content: string }>;
  mentionCount: number;
}

export interface MergeDisambiguationResult {
  signalCount: number;
  groupCount: number;
  autoMergeQueued: number;
  llmDisambiguated: number;
  routedToReviewQueue: number;
  skipped: number;
  actions: MergeAction[];
}

export interface MergeAction {
  sourceEntityId: string;
  sourceEntityName: string;
  targetEntityId: string;
  targetEntityName: string;
  decision: 'auto_merge' | 'keep_separate' | 'review_queue' | 'skipped';
  confidence: 'high' | 'medium' | 'low';
  segmentCount: number;
  reason: string;
  /** False until graph merge infrastructure (move mentions + facets) is implemented */
  applied: boolean;
}

// ─── LLM response schema ─────────────────────────────────────────────────────

interface LLMDisambiguationResponse {
  decision: 'merge' | 'keep_separate' | 'uncertain';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

const disambiguationSchema = {
  type: GeminiType.OBJECT,
  properties: {
    decision: {
      type: GeminiType.STRING,
      enum: ['merge', 'keep_separate', 'uncertain'],
      description:
        'merge = they are the same entity; keep_separate = distinct entities; uncertain = cannot determine',
    },
    confidence: {
      type: GeminiType.STRING,
      enum: ['high', 'medium', 'low'],
    },
    reasoning: {
      type: GeminiType.STRING,
      description: 'One sentence explaining the decision',
    },
  },
  required: ['decision', 'confidence', 'reasoning'],
};

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the merge signal disambiguation pass at the end of Stage 4.
 *
 * Call this after all entity creation is complete so that entity IDs are stable.
 */
export async function disambiguateMergeSignals(
  input: MergeDisambiguationInput,
): Promise<MergeDisambiguationResult> {
  const {
    documentId,
    userId,
    mergeSignals,
    entityIdByName,
    entityRegistryById,
  } = input;

  const result: MergeDisambiguationResult = {
    signalCount: mergeSignals.length,
    groupCount: 0,
    autoMergeQueued: 0,
    llmDisambiguated: 0,
    routedToReviewQueue: 0,
    skipped: 0,
    actions: [],
  };

  if (mergeSignals.length === 0) {
    logger.info({ documentId }, 'No merge signals to disambiguate');
    return result;
  }

  // Group signals by (extractedEntityName, registryName) pair so multiple segment
  // attestations of the same potential merge are counted together.
  const groups = groupSignals(mergeSignals);
  result.groupCount = groups.size;

  logger.info(
    { documentId, signalCount: mergeSignals.length, groupCount: groups.size },
    'Disambiguating merge signals',
  );

  for (const [_key, group] of groups) {
    const action = await processSignalGroup(group, {
      documentId,
      userId,
      entityIdByName,
      entityRegistryById,
    });

    if (!action) continue;

    result.actions.push(action);

    switch (action.decision) {
      case 'auto_merge':
        result.autoMergeQueued++;
        break;
      case 'review_queue':
        result.routedToReviewQueue++;
        break;
      case 'keep_separate':
        result.llmDisambiguated++;
        break;
      case 'skipped':
        result.skipped++;
        break;
    }
  }

  logger.info(
    {
      documentId,
      ...result,
      actions: undefined, // omit verbose array from summary log
    },
    'Merge disambiguation complete',
  );

  return result;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

interface SignalGroup {
  extractedEntityName: string;
  registryName: string;
  registryType: string;
  signals: AccumulatedMergeSignalWithContext[];
  /** Number of distinct segment indices that produced this signal pair */
  segmentCount: number;
  /** Highest confidence level seen across all signals in this group */
  maxConfidence: 'high' | 'medium' | 'low';
}

function groupSignals(
  signals: AccumulatedMergeSignalWithContext[],
): Map<string, SignalGroup> {
  const groups = new Map<string, SignalGroup>();

  for (const signal of signals) {
    const key = `${signal.extractedEntityName.toLowerCase()}||${signal.registryName.toLowerCase()}`;
    const existing = groups.get(key);

    if (existing) {
      existing.signals.push(signal);
      existing.segmentCount = new Set(
        existing.signals.map((s) => s.segmentIndex),
      ).size;
      existing.maxConfidence = higherConfidence(
        existing.maxConfidence,
        signal.confidence,
      );
    } else {
      groups.set(key, {
        extractedEntityName: signal.extractedEntityName,
        registryName: signal.registryName,
        registryType: signal.registryType,
        signals: [signal],
        segmentCount: 1,
        maxConfidence: signal.confidence,
      });
    }
  }

  return groups;
}

function higherConfidence(
  a: 'high' | 'medium' | 'low',
  b: 'high' | 'medium' | 'low',
): 'high' | 'medium' | 'low' {
  const rank = { high: 2, medium: 1, low: 0 };
  return rank[a] >= rank[b] ? a : b;
}

// ─── Per-group processing ────────────────────────────────────────────────────

async function processSignalGroup(
  group: SignalGroup,
  context: {
    documentId: string;
    userId: string;
    entityIdByName: Map<string, string>;
    entityRegistryById: Map<string, RuntimeEntitySummary>;
  },
): Promise<MergeAction | null> {
  const { documentId, userId, entityIdByName, entityRegistryById } = context;

  const sourceEntityId = entityIdByName.get(group.extractedEntityName);
  // registryName belongs to an entity that was in the registry when the signal fired.
  // It may be under the exact name or an alias — try both.
  const targetEntityId =
    entityIdByName.get(group.registryName) ??
    findByRegistryName(group.registryName, entityRegistryById);

  if (!sourceEntityId || !targetEntityId) {
    logger.debug(
      {
        extractedEntityName: group.extractedEntityName,
        registryName: group.registryName,
        hasSource: !!sourceEntityId,
        hasTarget: !!targetEntityId,
      },
      'Skipping merge signal — entity ID not resolvable',
    );
    return null;
  }

  if (sourceEntityId === targetEntityId) {
    // Already merged during extraction
    return null;
  }

  const baseAction: Omit<MergeAction, 'decision' | 'reason' | 'applied'> = {
    sourceEntityId,
    sourceEntityName: group.extractedEntityName,
    targetEntityId,
    targetEntityName: group.registryName,
    confidence: group.maxConfidence,
    segmentCount: group.segmentCount,
  };

  // Low-confidence signals are not worth LLM cost — skip them.
  if (group.maxConfidence === 'low') {
    logger.debug(
      { sourceEntityId, targetEntityId },
      'Skipping low-confidence merge signal',
    );
    return {
      ...baseAction,
      decision: 'skipped',
      reason: 'low confidence',
      applied: false,
    };
  }

  // High-confidence with 3+ segment attestations: auto-merge.
  if (group.maxConfidence === 'high' && group.segmentCount >= 3) {
    logger.info(
      {
        sourceEntityId,
        sourceEntityName: group.extractedEntityName,
        targetEntityId,
        targetEntityName: group.registryName,
        segmentCount: group.segmentCount,
      },
      'Auto-merge queued (high confidence, 3+ segments) — awaiting graph merge infrastructure',
    );
    return {
      ...baseAction,
      decision: 'auto_merge',
      reason: `${group.segmentCount} independent segments agree with high confidence`,
      applied: false,
    };
  }

  // Medium-confidence or high-confidence with <3 segments: run LLM disambiguation.
  return await runLLMDisambiguation(group, baseAction, {
    documentId,
    userId,
    entityRegistryById,
  });
}

function findByRegistryName(
  name: string,
  registryById: Map<string, RuntimeEntitySummary>,
): string | undefined {
  const normalized = name.toLowerCase().trim();
  for (const entry of registryById.values()) {
    if (
      entry.name.toLowerCase().trim() === normalized ||
      entry.aliases.some((a) => a.toLowerCase().trim() === normalized)
    ) {
      return entry.id;
    }
  }
  return undefined;
}

// ─── LLM disambiguation ───────────────────────────────────────────────────────

async function runLLMDisambiguation(
  group: SignalGroup,
  baseAction: Omit<MergeAction, 'decision' | 'reason' | 'applied'>,
  context: {
    documentId: string;
    userId: string;
    entityRegistryById: Map<string, RuntimeEntitySummary>;
  },
): Promise<MergeAction> {
  const { documentId, userId, entityRegistryById } = context;

  const sourceEntity = entityRegistryById.get(baseAction.sourceEntityId);
  const targetEntity = entityRegistryById.get(baseAction.targetEntityId);

  if (!sourceEntity || !targetEntity) {
    // No facet data to send the LLM — route to review queue.
    return routeToReviewQueue(
      baseAction,
      documentId,
      'Entity facets not available for disambiguation',
    );
  }

  const client = await getGeminiClient();
  if (!client) {
    logger.warn(
      { documentId },
      'Gemini unavailable — routing merge signal to review queue',
    );
    return routeToReviewQueue(baseAction, documentId, 'LLM unavailable');
  }

  const evidenceTexts = group.signals
    .map((s) => `[Segment ${s.segmentIndex}] ${s.evidence}`)
    .join('\n');

  const prompt = buildDisambiguationPrompt(
    sourceEntity,
    targetEntity,
    evidenceTexts,
  );

  try {
    const raw = await trackedAI.callLLM({
      operation: 'disambiguateMergeSignal',
      model: 'gemini-2.5-flash',
      userId,
      documentId,
      stage: 4,
      logger,
      execute: async () =>
        client.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: disambiguationSchema,
            maxOutputTokens: 256,
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
    });

    const text = (raw as { text?: string }).text;
    if (!text) throw new Error('Empty LLM response');

    const response = JSON.parse(text) as LLMDisambiguationResponse;

    logger.info(
      {
        sourceEntityName: baseAction.sourceEntityName,
        targetEntityName: baseAction.targetEntityName,
        decision: response.decision,
        confidence: response.confidence,
        reasoning: response.reasoning,
      },
      'LLM merge disambiguation result',
    );

    if (response.decision === 'merge') {
      if (response.confidence === 'high' || response.confidence === 'medium') {
        return {
          ...baseAction,
          decision: 'auto_merge',
          reason: response.reasoning,
          applied: false,
        };
      }
      return routeToReviewQueue(baseAction, documentId, response.reasoning);
    }

    if (response.decision === 'uncertain') {
      return routeToReviewQueue(baseAction, documentId, response.reasoning);
    }

    // keep_separate
    return {
      ...baseAction,
      decision: 'keep_separate',
      reason: response.reasoning,
      applied: false,
    };
  } catch (error) {
    logger.warn(
      {
        error,
        sourceEntityName: baseAction.sourceEntityName,
        targetEntityName: baseAction.targetEntityName,
      },
      'LLM disambiguation failed — routing to review queue',
    );
    return routeToReviewQueue(
      baseAction,
      documentId,
      `LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildDisambiguationPrompt(
  source: RuntimeEntitySummary,
  target: RuntimeEntitySummary,
  evidenceTexts: string,
): string {
  const formatEntity = (e: RuntimeEntitySummary) => {
    const facetLines = e.facets
      .map((f) => `  ${f.type}: ${f.content}`)
      .join('\n');
    const aliases = e.aliases.length > 0 ? e.aliases.join(', ') : 'none';
    return `Name: ${e.name}\nType: ${e.type}\nAliases: ${aliases}\nFacets:\n${facetLines}`;
  };

  return `You are disambiguating two entities extracted from a document to determine if they refer to the same real-world entity.

ENTITY A (newly extracted):
${formatEntity(source)}

ENTITY B (existing in knowledge graph):
${formatEntity(target)}

EVIDENCE (text passages where A and B were flagged as potential matches):
${evidenceTexts}

Decide: are these the same entity ("merge"), definitively different ("keep_separate"), or too ambiguous to decide automatically ("uncertain")?

Return JSON with decision, confidence, and one-sentence reasoning.`;
}

// ─── Review queue routing ─────────────────────────────────────────────────────

async function routeToReviewQueue(
  baseAction: Omit<MergeAction, 'decision' | 'reason' | 'applied'>,
  documentId: string,
  reason: string,
): Promise<MergeAction> {
  // Import lazily to avoid circular dependency and to respect the TODO comment
  // in pipeline.ts (review queue UI not yet built).
  try {
    const { reviewQueueService } = await import('../reviewQueue/index.js');
    await reviewQueueService.add({
      documentId,
      itemType: 'merge_suggestion',
      primaryEntityId: baseAction.sourceEntityId,
      secondaryEntityId: baseAction.targetEntityId,
      contextSummary: `Possible merge: "${baseAction.sourceEntityName}" may be the same as "${baseAction.targetEntityName}". ${reason}`,
      similarity:
        baseAction.confidence === 'high'
          ? 0.85
          : baseAction.confidence === 'medium'
            ? 0.65
            : 0.45,
    });
    logger.info(
      {
        sourceEntityId: baseAction.sourceEntityId,
        targetEntityId: baseAction.targetEntityId,
        reason,
      },
      'Merge signal routed to review queue',
    );
  } catch (error) {
    logger.warn(
      {
        error,
        sourceEntityId: baseAction.sourceEntityId,
        targetEntityId: baseAction.targetEntityId,
      },
      'Failed to route merge signal to review queue — decision logged only',
    );
  }

  return {
    ...baseAction,
    decision: 'review_queue',
    reason,
    applied: false,
  };
}

// ─── Registry builder ─────────────────────────────────────────────────────────

/**
 * Build a RuntimeEntitySummary map from extracted entities and the name→ID map.
 *
 * Collapses multiple ExtractedEntity instances for the same entity ID, merging
 * their facets and summing mention counts. This is the correct source of truth
 * at Stage 4 time because runtimeRegistry is scoped to Stage 3's block.
 */
export function buildEntityRegistrySummary(
  extractedEntities: Array<{
    name: string;
    type: string;
    facets: Array<{ type: string; content: string }>;
    mentions: Array<unknown>;
  }>,
  entityIdByName: Map<string, string>,
): Map<string, RuntimeEntitySummary> {
  const summaryById = new Map<string, RuntimeEntitySummary>();

  for (const entity of extractedEntities) {
    const id = entityIdByName.get(entity.name);
    if (!id) continue;

    const existing = summaryById.get(id);
    if (existing) {
      existing.mentionCount += entity.mentions.length;
      for (const facet of entity.facets) {
        const key = `${facet.type}:${facet.content}`;
        if (!existing.facets.some((f) => `${f.type}:${f.content}` === key)) {
          existing.facets.push(facet);
        }
      }
      if (
        entity.name !== existing.name &&
        !existing.aliases.includes(entity.name)
      ) {
        existing.aliases.push(entity.name);
      }
    } else {
      summaryById.set(id, {
        id,
        name: entity.name,
        type: entity.type,
        aliases: [],
        facets: entity.facets.map((f) => ({
          type: f.type,
          content: f.content,
        })),
        mentionCount: entity.mentions.length,
      });
    }
  }

  return summaryById;
}
