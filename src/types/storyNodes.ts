/**
 * Shared types for story node analysis and management.
 * Used by Gemini client, text analysis service, and repositories.
 */

export type StoryNodeType = 'character' | 'location' | 'event' | 'concept' | 'other';

export type StoryEdgeType =
  | 'CAUSES' | 'ENABLES' | 'PREVENTS'
  | 'HAPPENS_BEFORE'
  | 'LOCATED_IN'
  | 'APPEARS_IN' | 'KNOWS' | 'OPPOSES'
  | 'BELONGS_TO_THREAD'
  | 'RELATED_TO';

export interface StoryNodePassage {
  text: string;
  context?: string;
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
  passages: StoryNodePassage[];
  metadata?: Record<string, unknown>;
  narrativeOrder?: number;
  documentOrder?: number;
}

export interface StoryConnectionResult {
  fromName: string;
  toName: string;
  edgeType: StoryEdgeType;
  description: string;
  strength?: number;
  narrativeDistance?: number;
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
  passages: StoryNodePassage[];
}

export interface NodeUpdate {
  id: string;
  name?: string;
  description?: string;
  passages?: StoryNodePassage[];
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
