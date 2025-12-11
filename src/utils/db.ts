import { SQL, isNull } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';

export function notDeleted(column: PgColumn): SQL {
  return isNull(column);
}
