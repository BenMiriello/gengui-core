/**
 * Shared types for story node analysis and management.
 * Used by Gemini client, text analysis service, and repositories.
 */

export type StoryNodeType = 'character' | 'location' | 'event' | 'concept' | 'other';

export type StoryEdgeType =
  // Layer 2 (causal/temporal)
  | 'CAUSES' | 'ENABLES' | 'PREVENTS' | 'HAPPENS_BEFORE'
  // Layer 3 (structural/relational)
  | 'PARTICIPATES_IN' | 'LOCATED_AT' | 'PART_OF' | 'MEMBER_OF'
  | 'POSSESSES' | 'CONNECTED_TO' | 'OPPOSES' | 'ABOUT'
  // System
  | 'BELONGS_TO_THREAD'
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

export interface StoryNodeResult {
  type: StoryNodeType;
  name: string;
  description: string;
  aliases?: string[];
  mentions: StoryNodeMention[];
  metadata?: Record<string, unknown>;
  documentOrder?: number;
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
