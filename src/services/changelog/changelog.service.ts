import { randomUUID } from 'node:crypto';
import { arrayContains, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { changeLog } from '../../models/schema';
import type {
  ChangeLogEntry,
  ChangeLogPage,
  CreateChangeLogInput,
  Operation,
  TargetType,
} from './changelog.types';

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

function generateSummary(input: CreateChangeLogInput): string {
  const { operation, targetType, changeData, entityName, fromName, toName } =
    input;

  switch (targetType) {
    case 'entity': {
      if (operation === 'create') {
        const created = changeData.created as { type?: string; name?: string };
        return `Created ${created?.type || 'entity'} '${created?.name || 'unknown'}'`;
      }
      if (operation === 'update') {
        const after = changeData.after as Record<string, unknown>;
        const changedFields = Object.keys(after || {}).join(', ');
        return `Updated ${entityName || 'entity'}: changed ${changedFields}`;
      }
      if (operation === 'delete') {
        const deleted = changeData.deleted as { type?: string; name?: string };
        return `Deleted ${deleted?.type || 'entity'} '${deleted?.name || 'unknown'}'`;
      }
      if (operation === 'merge') {
        const mergedFrom = changeData.mergedFrom as { name?: string };
        const mergedInto = changeData.mergedInto as { name?: string };
        return `Merged '${mergedFrom?.name || fromName}' into '${mergedInto?.name || toName}'`;
      }
      break;
    }

    case 'facet': {
      if (operation === 'create') {
        const created = changeData.created as { type?: string; content?: string };
        const content = truncate(created?.content || '', 50);
        return `Added ${created?.type || 'facet'} '${content}' to ${entityName || 'entity'}`;
      }
      if (operation === 'update') {
        const before = changeData.before as { type?: string };
        return `Changed ${before?.type || 'facet'} on ${entityName || 'entity'}`;
      }
      if (operation === 'delete') {
        const deleted = changeData.deleted as { type?: string; content?: string };
        const content = truncate(deleted?.content || '', 50);
        return `Removed ${deleted?.type || 'facet'} '${content}' from ${entityName || 'entity'}`;
      }
      break;
    }

    case 'edge': {
      if (operation === 'create') {
        const created = changeData.created as { edgeType?: string };
        return `Connected: ${fromName || 'entity'} ${created?.edgeType || 'RELATED_TO'} ${toName || 'entity'}`;
      }
      if (operation === 'delete') {
        const deleted = changeData.deleted as { edgeType?: string };
        return `Removed relationship: ${fromName || 'entity'} ${deleted?.edgeType || ''} ${toName || 'entity'}`;
      }
      break;
    }

    case 'mention': {
      if (operation === 'create') {
        return `Found mention of ${entityName || 'entity'}`;
      }
      if (operation === 'update') {
        return `Updated mention of ${entityName || 'entity'}`;
      }
      if (operation === 'delete') {
        return `Removed mention of ${entityName || 'entity'}`;
      }
      break;
    }

    case 'character_state': {
      if (operation === 'create') {
        const created = changeData.created as { summary?: string };
        const summary = truncate(created?.summary || '', 50);
        return `Added state '${summary}' to ${entityName || 'character'}`;
      }
      if (operation === 'delete') {
        return `Removed state from ${entityName || 'character'}`;
      }
      break;
    }

    case 'arc': {
      if (operation === 'create') {
        const created = changeData.created as { arcType?: string };
        return `Added ${created?.arcType || ''} arc to ${entityName || 'character'}`;
      }
      if (operation === 'delete') {
        return `Removed arc from ${entityName || 'character'}`;
      }
      break;
    }

    case 'thread': {
      if (operation === 'create') {
        const created = changeData.created as { name?: string };
        return `Created thread '${created?.name || 'unnamed'}'`;
      }
      if (operation === 'update') {
        return `Updated thread '${entityName || 'thread'}'`;
      }
      if (operation === 'delete') {
        return `Deleted thread '${entityName || 'thread'}'`;
      }
      break;
    }
  }

  return `${operation} ${targetType}`;
}

function rowToEntry(
  row: typeof changeLog.$inferSelect,
): ChangeLogEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    source: row.source,
    targetType: row.targetType as TargetType,
    targetId: row.targetId,
    operation: row.operation as Operation,
    relatedEntityIds: row.relatedEntityIds ?? [],
    summary: row.summary,
    changeData: row.changeData as Record<string, unknown>,
    reason: row.reason,
    sourcePosition: row.sourcePosition,
    batchId: row.batchId,
  };
}

/**
 * Build change data for an update operation by comparing before/after objects.
 * Only includes fields that were actually provided in the updates.
 */
function buildUpdateChangeData(
  before: Record<string, unknown>,
  updates: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const beforeData: Record<string, unknown> = {};
  const afterData: Record<string, unknown> = {};

  for (const key of Object.keys(updates)) {
    if (updates[key] !== undefined) {
      beforeData[key] = before[key];
      afterData[key] = updates[key];
    }
  }

  return { before: beforeData, after: afterData };
}

export const changeLogService = {
  generateBatchId(): string {
    return randomUUID();
  },

  buildUpdateChangeData,

  async log(input: CreateChangeLogInput): Promise<ChangeLogEntry> {
    const summary = generateSummary(input);

    const [row] = await db
      .insert(changeLog)
      .values({
        source: input.source,
        targetType: input.targetType,
        targetId: input.targetId,
        operation: input.operation,
        relatedEntityIds: input.relatedEntityIds,
        summary,
        changeData: input.changeData,
        reason: input.reason ?? null,
        sourcePosition: input.sourcePosition ?? null,
        batchId: input.batchId ?? null,
      })
      .returning();

    return rowToEntry(row);
  },

  async getForEntity(
    entityId: string,
    limit: number = 10,
    offset: number = 0,
  ): Promise<ChangeLogPage> {
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(changeLog)
      .where(arrayContains(changeLog.relatedEntityIds, [entityId]));

    const total = countResult?.count ?? 0;

    const rows = await db
      .select()
      .from(changeLog)
      .where(arrayContains(changeLog.relatedEntityIds, [entityId]))
      .orderBy(desc(changeLog.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset);

    return {
      entries: rows.map(rowToEntry),
      total,
      limit,
      offset,
    };
  },

  async getForBatch(batchId: string): Promise<ChangeLogEntry[]> {
    const rows = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.batchId, batchId))
      .orderBy(changeLog.createdAt);

    return rows.map(rowToEntry);
  },

  async getRecent(limit: number = 100): Promise<ChangeLogEntry[]> {
    const rows = await db
      .select()
      .from(changeLog)
      .orderBy(desc(changeLog.createdAt))
      .limit(Math.min(limit, 100));

    return rows.map(rowToEntry);
  },
};
