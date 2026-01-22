/**
 * Shared types for story node analysis and management.
 * Used by Gemini client, text analysis service, and repositories.
 */

export type StoryNodeType = 'character' | 'location' | 'event' | 'other';

export interface StoryNodePassage {
  text: string;
  context?: string;
}

export interface TextPosition {
  start: number;
  end: number;
  text: string;
}

// Result from LLM analysis (fresh analysis)
export interface StoryNodeResult {
  type: StoryNodeType;
  name: string;
  description: string;
  passages: StoryNodePassage[];
  metadata?: Record<string, unknown>;
}

export interface StoryConnectionResult {
  fromName: string;
  toName: string;
  description: string;
}

export interface AnalysisResult {
  nodes: StoryNodeResult[];
  connections: StoryConnectionResult[];
}

// Types for incremental node updates
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
  description: string;
}

export interface NodeUpdatesResult {
  add: StoryNodeResult[];
  update: NodeUpdate[];
  delete: string[];
  connectionUpdates: {
    add: ConnectionUpdate[];
    delete: { fromId: string; toId: string }[];
  };
}
