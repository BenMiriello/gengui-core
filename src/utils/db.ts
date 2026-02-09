import { isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export function notDeleted(column: PgColumn): SQL {
  return isNull(column);
}
