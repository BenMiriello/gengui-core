/**
 * Advisory locking for document analysis.
 * Prevents concurrent analysis of the same document.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../config/database';
import { logger } from '../utils/logger';

/**
 * Convert UUID to int64 for use with pg_advisory_lock.
 */
function uuidToInt64(uuid: string): bigint {
  const hash = createHash('md5').update(`analysis:${uuid}`).digest('hex');
  return BigInt(`0x${hash.slice(0, 16)}`);
}

export const analysisLock = {
  /**
   * Try to acquire an advisory lock for document analysis.
   * Returns true if lock was acquired, false if already held by another session.
   */
  async tryAcquire(documentId: string): Promise<boolean> {
    const lockId = uuidToInt64(documentId);

    const result = await db.execute(
      sql`SELECT pg_try_advisory_lock(${lockId.toString()}::bigint) as acquired`,
    );

    const acquired = (result as any)[0]?.acquired === true;

    if (acquired) {
      logger.debug({ documentId, lockId: lockId.toString() }, 'Analysis lock acquired');
    } else {
      logger.info(
        { documentId, lockId: lockId.toString() },
        'Analysis lock already held, skipping',
      );
    }

    return acquired;
  },

  /**
   * Release the advisory lock for document analysis.
   */
  async release(documentId: string): Promise<void> {
    const lockId = uuidToInt64(documentId);

    await db.execute(
      sql`SELECT pg_advisory_unlock(${lockId.toString()}::bigint)`,
    );

    logger.debug({ documentId, lockId: lockId.toString() }, 'Analysis lock released');
  },

  /**
   * Execute a function while holding the analysis lock.
   * Releases lock on completion or error.
   */
  async withLock<T>(
    documentId: string,
    fn: () => Promise<T>,
  ): Promise<{ success: true; result: T } | { success: false; reason: 'locked' }> {
    const acquired = await this.tryAcquire(documentId);

    if (!acquired) {
      return { success: false, reason: 'locked' };
    }

    try {
      const result = await fn();
      return { success: true, result };
    } finally {
      await this.release(documentId);
    }
  },
};
