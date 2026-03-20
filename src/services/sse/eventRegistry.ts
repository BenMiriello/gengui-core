/**
 * SSE Event Registry
 *
 * Single source of truth for all SSE events and their query invalidation patterns.
 * This ensures consistency between backend event emission and frontend query invalidation.
 */

export type SSEEventName =
  // Document events
  | 'document-updated'
  | 'document-deleted'
  // Mention events
  | 'mention-key-passage-updated'
  // Node events
  | 'node-updated'
  | 'node-deleted'
  | 'nodes-updated'
  | 'node-primary-media-updated'
  // Media events
  | 'media-uploaded'
  | 'media-deleted'
  | 'media-update'
  // Activity events
  | 'activity-created'
  | 'activity-updated'
  | 'activity-deleted';

export interface SSEEvent<T = unknown> {
  event: SSEEventName;
  data: T;
  timestamp: string;
}

// Event payload types
export interface DocumentUpdatedEvent {
  documentId: string;
  currentVersion: number;
  updatedAt: string;
}

export interface DocumentDeletedEvent {
  documentId: string;
}

export interface MentionKeyPassageUpdatedEvent {
  documentId: string;
  mentionId: string;
  nodeId: string;
  isKeyPassage: boolean;
  timestamp: number;
}

export interface NodeUpdatedEvent {
  documentId: string;
  nodeId: string;
  facetId?: string;
}

export interface NodeDeletedEvent {
  documentId: string;
  nodeIds: string[];
}

export interface NodesUpdatedEvent {
  documentId: string;
  nodeIds: string[];
}

export interface NodePrimaryMediaUpdatedEvent {
  documentId: string;
  nodeId: string;
  primaryMediaId: string | null;
  primaryMediaUrl: string | null;
}

export interface MediaUpdateEvent {
  documentId: string;
  mediaId: string;
}

export interface MediaUploadedEvent {
  documentId: string;
  mediaId: string;
  nodeId?: string;
}

export interface MediaDeletedEvent {
  documentId: string;
  mediaId: string;
  nodeId?: string;
}

export interface ActivityCreatedEvent {
  activityId: string;
  activityType: string;
  targetId: string;
}

export interface ActivityUpdatedEvent {
  activityId: string;
  status: string;
  progress?: unknown;
}

export interface ActivityDeletedEvent {
  activityId: string;
}

/**
 * Query key patterns that should be invalidated for each event type.
 * These match the query key factory in frontend/src/queries/queryKeys.ts
 */
export const EVENT_INVALIDATION_MAP: Record<
  SSEEventName,
  Array<string | string[]>
> = {
  'document-updated': [
    ['documents', ':documentId'],
    ['documents', ':documentId', 'mentions'],
    ['documents', ':documentId', 'nodes'],
  ],
  'document-deleted': [['documents', ':documentId']],

  'mention-key-passage-updated': [
    ['documents', ':documentId', 'mentions'],
    ['documents', ':documentId', 'nodes'],
  ],

  'node-updated': [
    ['nodes', ':nodeId'],
    ['documents', ':documentId', 'nodes'],
    ['documents', ':documentId', 'graphAnalysis'],
  ],
  'node-deleted': [
    ['documents', ':documentId', 'nodes'],
    ['documents', ':documentId', 'mentions'],
    ['documents', ':documentId', 'graphAnalysis'],
    ['nodes', ':nodeId'],
  ],
  'nodes-updated': [
    ['documents', ':documentId', 'nodes'],
    ['documents', ':documentId', 'graphAnalysis'],
  ],
  'node-primary-media-updated': [
    ['nodes', ':nodeId'],
    ['nodes', ':nodeId', 'media'],
  ],

  'media-uploaded': [
    ['documents', ':documentId', 'media'],
    ['nodes', ':nodeId', 'media'],
  ],
  'media-deleted': [
    ['documents', ':documentId', 'media'],
    ['nodes', ':nodeId', 'media'],
  ],
  'media-update': [['documents', ':documentId', 'media']],

  'activity-created': [['activities']],
  'activity-updated': [['activities'], ['activities', ':activityId']],
  'activity-deleted': [['activities'], ['activities', ':activityId']],
};
