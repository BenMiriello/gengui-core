import type { StoryNodeType, StoryEdgeType } from '../../types/storyNodes';

export interface NodeProperties {
  [key: string]: string | number | boolean | null;
}

export interface StoredStoryNode {
  id: string;
  documentId: string;
  userId: string;
  type: StoryNodeType;
  name: string;
  description: string | null;
  aliases: string[] | null;
  metadata: string | null;
  primaryMediaId: string | null;
  stylePreset: string | null;
  stylePrompt: string | null;
  documentOrder: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StoredStoryConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: StoryEdgeType;
  description: string | null;
  strength: number | null;
  narrativeDistance: number | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface QueryResult {
  headers: string[];
  data: unknown[][];
  stats: Record<string, string>;
}

export interface NarrativeThread {
  id: string;
  documentId: string;
  userId: string;
  name: string;
  isPrimary: boolean;
  color: string | null;
  createdAt: string;
}

export interface ThreadMembership {
  eventId: string;
  threadId: string;
  order: number;
}

export interface CausalOrderResult {
  nodeId: string;
  position: number;
  tiedWith?: string[];
}

export interface ThreadDetectionResult {
  memberNodeIds: string[];
  suggestedName?: string;
}

export const CAUSAL_EDGE_TYPES: StoryEdgeType[] = [
  'CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE',
];

/**
 * Generate Cypher edge pattern for causal relationship types.
 * FalkorDB requires literal edge types in patterns (cannot be parameterized).
 * Use this helper to keep patterns in sync with CAUSAL_EDGE_TYPES constant.
 *
 * @param variableHops - Optional hop range, e.g., "*1..50" for variable-length paths
 * @returns Pattern like ":CAUSES|ENABLES|PREVENTS|HAPPENS_BEFORE" or with hops
 */
export function causalEdgePattern(variableHops?: string): string {
  const types = CAUSAL_EDGE_TYPES.join('|');
  return variableHops ? `:${types}${variableHops}` : `:${types}`;
}
