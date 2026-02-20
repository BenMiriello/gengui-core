/**
 * Entity Resolution Types
 *
 * Multi-signal batch clustering for entity resolution.
 * Replaces per-entity LLM calls with algorithmic clustering.
 */

import type { FacetInput, StoryNodeType } from '../../types/storyNodes';

// ========== Signal Weights ==========

export interface SignalWeights {
  embedding: number;
  name: number;
  type: number;
  graph: number;
}

export const DEFAULT_WEIGHTS: SignalWeights = {
  embedding: 0.5,
  name: 0.3,
  type: 0.1,
  graph: 0.1,
};

export const WEIGHTS_BY_TYPE: Record<StoryNodeType, SignalWeights> = {
  character: { embedding: 0.5, name: 0.3, type: 0.1, graph: 0.1 },
  location: { embedding: 0.4, name: 0.4, type: 0.1, graph: 0.1 },
  event: { embedding: 0.55, name: 0.2, type: 0.1, graph: 0.15 },
  concept: { embedding: 0.6, name: 0.15, type: 0.1, graph: 0.15 },
  other: { embedding: 0.5, name: 0.3, type: 0.1, graph: 0.1 },
  character_state: { embedding: 0.5, name: 0.3, type: 0.1, graph: 0.1 },
  arc: { embedding: 0.5, name: 0.3, type: 0.1, graph: 0.1 },
};

// ========== Thresholds ==========

export interface ResolutionThresholds {
  autoMerge: number;
  review: number;
  withinSegment: number;
}

export const DEFAULT_THRESHOLDS: ResolutionThresholds = {
  autoMerge: 0.85,
  review: 0.5,
  withinSegment: 0.75,
};

// ========== Entity Candidates ==========

export interface EntityCandidate {
  name: string;
  type: StoryNodeType;
  embedding: number[];
  facets: FacetInput[];
  mentions: Array<{ text: string; segmentId?: string }>;
  segmentId: string;
  documentOrder?: number;
}

export interface ExistingEntity {
  id: string;
  name: string;
  type: string;
  embedding?: number[];
  aliases?: string[];
  facets: Array<{ type: string; content: string }>;
  mentionCount: number;
}

// ========== Signal Breakdown ==========

export interface SignalBreakdown {
  embedding: number;
  name: number;
  type: number;
  graph: number;
}

export interface ScoredCandidate {
  entity: ExistingEntity;
  score: number;
  signals: SignalBreakdown;
  confidence: number;
}

// ========== Clustering ==========

export interface EntityCluster {
  primaryName: string;
  type: StoryNodeType;
  aliases: string[];
  members: EntityCandidate[];
  mergedEmbedding: number[];
  mergedFacets: FacetInput[];
  mentions: Array<{ text: string; segmentId?: string }>;
  segmentIds: string[];
}

// ========== Resolution Results ==========

export type ResolutionDecision = 'MERGE' | 'REVIEW' | 'CREATE';

export interface ResolutionResult {
  decision: ResolutionDecision;
  targetId?: string;
  score: number;
  signals?: SignalBreakdown;
  confidence: number;
  reason: string;
}

export interface ClusterResolutionResult extends ResolutionResult {
  cluster: EntityCluster;
  newFacets?: FacetInput[];
}

// ========== Resolution Config ==========

export interface ResolutionConfig {
  weights: SignalWeights;
  thresholds: ResolutionThresholds;
  useLLMRefinement: boolean;
  llmScoreRange: { min: number; max: number };
}

export const DEFAULT_CONFIG: ResolutionConfig = {
  weights: DEFAULT_WEIGHTS,
  thresholds: DEFAULT_THRESHOLDS,
  useLLMRefinement: true,
  llmScoreRange: { min: 0.5, max: 0.85 },
};
