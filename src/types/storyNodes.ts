/**
 * Shared types for story node analysis and management.
 * Used by Gemini client, text analysis service, and repositories.
 */

export type StoryNodeType =
  | 'character'
  | 'location'
  | 'event'
  | 'concept'
  | 'other'
  | 'character_state'
  | 'arc';

export type ArcType =
  | 'transformation'
  | 'growth'
  | 'fall'
  | 'revelation'
  | 'static';

export type StoryEdgeType =
  // Layer 2 (causal/temporal)
  | 'CAUSES'
  | 'ENABLES'
  | 'PREVENTS'
  | 'HAPPENS_BEFORE'
  // Layer 3 (structural/relational)
  | 'PARTICIPATES_IN'
  | 'LOCATED_AT'
  | 'PART_OF'
  | 'MEMBER_OF'
  | 'POSSESSES'
  | 'CONNECTED_TO'
  | 'OPPOSES'
  | 'ABOUT'
  // System
  | 'BELONGS_TO_THREAD'
  // Character Arc edges
  | 'HAS_STATE'
  | 'HAS_FACET'
  | 'CHANGES_TO'
  | 'HAS_ARC'
  | 'INCLUDES_STATE'
  // Fallback
  | 'RELATED_TO';

export interface StoryNodeMention {
  text: string;
}

export interface TextPosition {
  start: number;
  end: number;
  text: string;
}

export interface EventRange {
  startMarker: string;
  endMarker: string;
}

export interface StoryNodeResult {
  type: StoryNodeType;
  name: string;
  description: string;
  aliases?: string[];
  mentions: StoryNodeMention[];
  metadata?: Record<string, unknown>;
  documentOrder?: number;
  eventRanges?: EventRange[];
}

export interface StoryConnectionResult {
  fromName: string;
  toName: string;
  edgeType: StoryEdgeType;
  description: string;
  strength?: number;
}

export interface NarrativeThreadResult {
  name: string;
  isPrimary: boolean;
  eventNames: string[];
}

export interface AnalysisResult {
  nodes: StoryNodeResult[];
  connections: StoryConnectionResult[];
  narrativeThreads?: NarrativeThreadResult[];
}

export interface ExistingNode {
  id: string;
  type: StoryNodeType;
  name: string;
  description: string;
  aliases?: string[];
  mentions: StoryNodeMention[];
}

export interface NodeUpdate {
  id: string;
  name?: string;
  description?: string;
  aliases?: string[];
  mentions?: StoryNodeMention[];
}

export interface ConnectionUpdate {
  fromId?: string;
  toId?: string;
  fromName?: string;
  toName?: string;
  edgeType?: StoryEdgeType;
  description: string;
  strength?: number;
}

export interface NodeUpdatesResult {
  add: StoryNodeResult[];
  update: NodeUpdate[];
  delete: string[];
  connectionUpdates: {
    add: ConnectionUpdate[];
    delete: { fromId: string; toId: string }[];
  };
  narrativeThreads?: NarrativeThreadResult[];
}

export type EntityResolutionMatch =
  | 'exact_name'
  | 'alias'
  | 'embedding'
  | 'new';

export interface ResolvedEntity {
  candidateName: string;
  resolvedId: string;
  matchType: EntityResolutionMatch;
  isNew: boolean;
  matchedExistingName?: string;
  similarity?: number;
}

export interface EntityResolutionResult {
  resolved: ResolvedEntity[];
  preserved: string[];
  softDeleted: string[];
}

// ========== Facet Types (Phase 1) ==========

export type FacetType = 'name' | 'appearance' | 'trait' | 'state';

export interface Facet {
  id: string;
  entityId: string;
  type: FacetType;
  content: string;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface FacetInput {
  type: FacetType;
  content: string;
}

export interface StoryNodeFacetResult {
  type: StoryNodeType;
  name: string;
  facets: FacetInput[];
  mentions: StoryNodeMention[];
  metadata?: Record<string, unknown>;
  documentOrder?: number;
  eventRanges?: EventRange[];
}

// ========== Incremental Analysis Actions (Phase 3) ==========

export type IncrementalAction =
  | IncrementalUpdateAction
  | IncrementalAddFacetAction
  | IncrementalRemoveFacetAction
  | IncrementalNewEntityAction
  | IncrementalNewConnectionAction;

export interface IncrementalUpdateAction {
  action: 'update';
  entityId: string;
  mentions: StoryNodeMention[];
}

export interface IncrementalAddFacetAction {
  action: 'add_facet';
  entityId: string;
  facet: FacetInput;
  mentions: StoryNodeMention[];
}

export interface IncrementalRemoveFacetAction {
  action: 'remove_facet';
  entityId: string;
  facetContent: string;
}

export interface IncrementalNewEntityAction {
  action: 'new';
  entity: StoryNodeFacetResult;
}

export interface IncrementalNewConnectionAction {
  action: 'new_connection';
  fromEntityId: string;
  toEntityId: string;
  edgeType: StoryEdgeType;
  description: string;
}

export interface IncrementalAnalysisResult {
  actions: IncrementalAction[];
}
