export type ChangeSource = 'user' | 'system';
export type TargetType =
  | 'entity'
  | 'facet'
  | 'edge'
  | 'mention'
  | 'arc_state'
  | 'arc'
  | 'thread';
export type Operation = 'create' | 'update' | 'delete' | 'merge';

export interface ChangeLogEntry {
  id: string;
  createdAt: Date;
  source: ChangeSource;
  targetType: TargetType;
  targetId: string;
  operation: Operation;
  relatedEntityIds: string[];
  summary: string;
  changeData: Record<string, unknown>;
  reason: string | null;
  sourcePosition: number | null;
  batchId: string | null;
}

export interface CreateChangeLogInput {
  source: ChangeSource;
  targetType: TargetType;
  targetId: string;
  operation: Operation;
  relatedEntityIds: string[];
  changeData: Record<string, unknown>;
  reason?: string | null;
  sourcePosition?: number | null;
  batchId?: string | null;
  entityName?: string;
  fromName?: string;
  toName?: string;
}

export interface ChangeLogPage {
  entries: ChangeLogEntry[];
  total: number;
  limit: number;
  offset: number;
}
