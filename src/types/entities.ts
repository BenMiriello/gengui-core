/**
 * Shared types for entity analysis and management.
 * Used by Gemini client, text analysis service, and repositories.
 */

export type NodeType =
  // Text-grounded entities
  | 'person'
  | 'place'
  | 'event'
  | 'concept'
  | 'object'
  | 'group'
  // Analytical structures
  | 'arc'
  | 'arc_state'
  | 'thread'
  | 'motif';

export type ArcType =
  | 'transformation'
  | 'growth'
  | 'fall'
  | 'revelation'
  | 'static';

export type EdgeType =
  // Foundation
  | 'PART_OF'
  | 'MEMBER_OF'
  | 'LOCATED_AT'
  | 'RELATED_TO'
  // Causal
  | 'CAUSES'
  | 'ENABLES'
  | 'PREVENTS'
  | 'HAPPENS_BEFORE'
  // Social
  | 'CONNECTED_TO'
  | 'OPPOSES'
  // Structural
  | 'PARTICIPATES_IN'
  | 'ABOUT'
  // Analytical
  | 'INCLUDES'
  | 'INSTANCE_OF'
  | 'HAS_FACET'
  | 'HAS_STATE'
  | 'CHANGES_TO'
  | 'HAS_ARC'
  | 'INCLUDES_STATE';

export interface EntityMention {
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

export interface EntityResult {
  type: NodeType;
  name: string;
  description: string;
  aliases?: string[];
  mentions: EntityMention[];
  metadata?: Record<string, unknown>;
  documentOrder?: number;
  eventRanges?: EventRange[];
}

export interface ConnectionResult {
  fromName: string;
  toName: string;
  edgeType: EdgeType;
  description: string;
  strength?: number;
}

export interface ThreadResult {
  name: string;
  isPrimary: boolean;
  eventNames: string[];
}

export interface AnalysisResult {
  nodes: EntityResult[];
  connections: ConnectionResult[];
  narrativeThreads?: ThreadResult[];
}

export interface ExistingNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  aliases?: string[];
  mentions: EntityMention[];
}

export interface EntityUpdate {
  id: string;
  name?: string;
  description?: string;
  aliases?: string[];
  mentions?: EntityMention[];
}

export interface ConnectionUpdate {
  fromId?: string;
  toId?: string;
  fromName?: string;
  toName?: string;
  edgeType?: EdgeType;
  description: string;
  strength?: number;
}

export interface EntityUpdatesResult {
  add: EntityResult[];
  update: EntityUpdate[];
  delete: string[];
  connectionUpdates: {
    add: ConnectionUpdate[];
    delete: { fromId: string; toId: string }[];
  };
  narrativeThreads?: ThreadResult[];
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

// ========== Facet Types ==========

export type FacetType =
  | 'name'
  | 'appearance'
  | 'trait'
  | 'state'
  | 'description';

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

export interface EntityFacetResult {
  type: NodeType;
  name: string;
  facets: FacetInput[];
  mentions: EntityMention[];
  metadata?: Record<string, unknown>;
  documentOrder?: number;
  eventRanges?: EventRange[];
}

// ========== Incremental Analysis Actions ==========

export type IncrementalAction =
  | IncrementalUpdateAction
  | IncrementalAddFacetAction
  | IncrementalRemoveFacetAction
  | IncrementalNewEntityAction
  | IncrementalNewConnectionAction;

export interface IncrementalUpdateAction {
  action: 'update';
  entityId: string;
  mentions: EntityMention[];
}

export interface IncrementalAddFacetAction {
  action: 'add_facet';
  entityId: string;
  facet: FacetInput;
  mentions: EntityMention[];
}

export interface IncrementalRemoveFacetAction {
  action: 'remove_facet';
  entityId: string;
  facetContent: string;
}

export interface IncrementalNewEntityAction {
  action: 'new';
  entity: EntityFacetResult;
}

export interface IncrementalNewConnectionAction {
  action: 'new_connection';
  fromEntityId: string;
  toEntityId: string;
  edgeType: EdgeType;
  description: string;
}

export interface IncrementalAnalysisResult {
  actions: IncrementalAction[];
}
