/**
 * Tracked mutation wrappers for the pipeline.
 *
 * These wrappers call graphService methods and log all mutations to the changelog.
 * Error handling: If changelog write fails, we log a warning but don't fail the pipeline
 * (since the FalkorDB mutation already succeeded).
 */

import type {
  ArcType,
  FacetInput,
  NarrativeThreadResult,
  StoryEdgeType,
  StoryNodeResult,
} from '../../types/storyNodes';
import { logger } from '../../utils/logger';
import { graphService } from '../graph/graph.service';
import type { ChangesToEdgeProps } from '../graph/graph.types';
import { changeLogService } from './changelog.service';

export interface TrackedMutationOptions {
  batchId?: string;
  reason?: string;
}

async function safeLog(
  logFn: () => Promise<unknown>,
  context: string,
): Promise<void> {
  try {
    await logFn();
  } catch (err) {
    logger.warn({ error: err, context }, 'Failed to write changelog entry');
  }
}

/**
 * Create entity with changelog tracking.
 */
export async function createTrackedEntity(
  documentId: string,
  userId: string,
  node: StoryNodeResult,
  options?: {
    stylePreset?: string | null;
    stylePrompt?: string | null;
    existingId?: string;
  },
  trackingOptions?: TrackedMutationOptions,
): Promise<{ id: string; created: boolean }> {
  const result = await graphService.createStoryNodeIdempotent(
    documentId,
    userId,
    node,
    options,
  );

  if (result.created) {
    await safeLog(
      () =>
        changeLogService.log({
          source: 'system',
          targetType: 'entity',
          targetId: result.id,
          operation: 'create',
          relatedEntityIds: [result.id],
          changeData: {
            created: {
              type: node.type,
              name: node.name,
              description: node.description,
            },
          },
          entityName: node.name,
          batchId: trackingOptions?.batchId,
          reason: trackingOptions?.reason,
        }),
      'createTrackedEntity',
    );
  }

  return result;
}

/**
 * Create facet with changelog tracking.
 */
export async function createTrackedFacet(
  entityId: string,
  facet: FacetInput,
  embedding?: number[],
  trackingOptions?: TrackedMutationOptions & { entityName?: string },
): Promise<string> {
  const facetId = await graphService.createFacet(entityId, facet, embedding);

  await safeLog(
    () =>
      changeLogService.log({
        source: 'system',
        targetType: 'facet',
        targetId: facetId,
        operation: 'create',
        relatedEntityIds: [entityId],
        changeData: {
          created: {
            type: facet.type,
            content: facet.content,
          },
        },
        entityName: trackingOptions?.entityName,
        batchId: trackingOptions?.batchId,
        reason: trackingOptions?.reason,
      }),
    'createTrackedFacet',
  );

  return facetId;
}

/**
 * Create edge with changelog tracking.
 */
export async function createTrackedEdge(
  fromId: string,
  toId: string,
  edgeType: StoryEdgeType,
  description: string | null,
  properties?: { strength?: number },
  trackingOptions?: TrackedMutationOptions & {
    fromName?: string;
    toName?: string;
  },
): Promise<{ id: string; created: boolean }> {
  const result = await graphService.createStoryConnectionIdempotent(
    fromId,
    toId,
    edgeType,
    description,
    properties,
  );

  if (result.created) {
    await safeLog(
      () =>
        changeLogService.log({
          source: 'system',
          targetType: 'edge',
          targetId: result.id,
          operation: 'create',
          relatedEntityIds: [fromId, toId],
          changeData: {
            created: {
              edgeType,
              description,
              strength: properties?.strength,
            },
          },
          fromName: trackingOptions?.fromName,
          toName: trackingOptions?.toName,
          batchId: trackingOptions?.batchId,
          reason: trackingOptions?.reason,
        }),
      'createTrackedEdge',
    );
  }

  return result;
}

/**
 * Create narrative thread with changelog tracking.
 */
export async function createTrackedThread(
  documentId: string,
  userId: string,
  thread: NarrativeThreadResult,
  trackingOptions?: TrackedMutationOptions,
): Promise<{ id: string; created: boolean }> {
  const result = await graphService.createNarrativeThreadIdempotent(
    documentId,
    userId,
    thread,
  );

  if (result.created) {
    await safeLog(
      () =>
        changeLogService.log({
          source: 'system',
          targetType: 'thread',
          targetId: result.id,
          operation: 'create',
          relatedEntityIds: [],
          changeData: {
            created: {
              name: thread.name,
              isPrimary: thread.isPrimary,
            },
          },
          entityName: thread.name,
          batchId: trackingOptions?.batchId,
          reason: trackingOptions?.reason,
        }),
      'createTrackedThread',
    );
  }

  return result;
}

/**
 * Create arc with changelog tracking.
 */
export async function createTrackedArc(
  characterId: string,
  documentId: string,
  userId: string,
  input: {
    arcType: ArcType;
    name?: string;
    summary?: string;
  },
  trackingOptions?: TrackedMutationOptions & { characterName?: string },
): Promise<string> {
  const arcId = await graphService.createArc(
    characterId,
    documentId,
    userId,
    input,
  );

  await safeLog(
    () =>
      changeLogService.log({
        source: 'system',
        targetType: 'arc',
        targetId: arcId,
        operation: 'create',
        relatedEntityIds: [characterId],
        changeData: {
          created: {
            arcType: input.arcType,
            name: input.name,
            summary: input.summary,
          },
        },
        entityName: trackingOptions?.characterName,
        batchId: trackingOptions?.batchId,
        reason: trackingOptions?.reason,
      }),
    'createTrackedArc',
  );

  return arcId;
}

/**
 * Create character state with changelog tracking.
 */
export async function createTrackedState(
  characterId: string,
  documentId: string,
  userId: string,
  input: {
    name: string;
    phaseIndex: number;
    documentOrder: number;
    causalOrder: number;
  },
  trackingOptions?: TrackedMutationOptions & { characterName?: string },
): Promise<string> {
  const stateId = await graphService.createCharacterState(
    characterId,
    documentId,
    userId,
    input,
  );

  await safeLog(
    () =>
      changeLogService.log({
        source: 'system',
        targetType: 'character_state',
        targetId: stateId,
        operation: 'create',
        relatedEntityIds: [characterId],
        changeData: {
          created: {
            name: input.name,
            phaseIndex: input.phaseIndex,
            documentOrder: input.documentOrder,
          },
        },
        entityName: trackingOptions?.characterName,
        batchId: trackingOptions?.batchId,
        reason: trackingOptions?.reason,
      }),
    'createTrackedState',
  );

  return stateId;
}

/**
 * Create state transition (CHANGES_TO edge) with changelog tracking.
 */
export async function createTrackedStateTransition(
  fromStateId: string,
  toStateId: string,
  props: ChangesToEdgeProps,
  trackingOptions?: TrackedMutationOptions & { characterId?: string },
): Promise<void> {
  await graphService.createChangesToEdge(fromStateId, toStateId, props);

  await safeLog(
    () =>
      changeLogService.log({
        source: 'system',
        targetType: 'edge',
        targetId: `${fromStateId}->${toStateId}`,
        operation: 'create',
        relatedEntityIds: trackingOptions?.characterId
          ? [trackingOptions.characterId]
          : [],
        changeData: {
          created: {
            edgeType: 'CHANGES_TO',
            triggerEventId: props.triggerEventId,
            gapDetected: props.gapDetected,
          },
        },
        batchId: trackingOptions?.batchId,
        reason: trackingOptions?.reason,
      }),
    'createTrackedStateTransition',
  );
}
