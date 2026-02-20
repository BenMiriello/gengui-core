import type { AnyColumn } from 'drizzle-orm';
import { type SQL, sql } from 'drizzle-orm';

export function buildActiveRecordsFilter(deletedAtColumn: AnyColumn): SQL {
  return sql`${deletedAtColumn} IS NULL`;
}

export function buildSoftDeleteUpdate(): { deletedAt: Date } {
  return { deletedAt: new Date() };
}

export function buildRestoreUpdate(): { deletedAt: null } {
  return { deletedAt: null };
}

export function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}
