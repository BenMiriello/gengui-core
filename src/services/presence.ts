import { redis } from './redis';
import { sseService } from './sse';
import { logger } from '../utils/logger';

const HEARTBEAT_TIMEOUT_MS = 15000;
const PRIMARY_LOCK_TTL_SECONDS = 30;

class PresenceService {
  async recordHeartbeat(documentId: string, sessionId: string): Promise<void> {
    const now = Date.now();
    const key = `doc:${documentId}:editors`;

    await Promise.all([
      this.cleanupStaleEditors(documentId),
      redis.zadd(key, now, sessionId),
    ]);

    logger.debug({ documentId, sessionId }, 'Heartbeat recorded');
  }

  async cleanupStaleEditors(documentId: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - HEARTBEAT_TIMEOUT_MS;
    const key = `doc:${documentId}:editors`;

    const removed = await redis.zremrangebyscore(key, 0, cutoff);
    if (removed > 0) {
      logger.info({ documentId, removed }, 'Cleaned up stale editors');
    }
  }

  async getActiveEditorCount(documentId: string): Promise<number> {
    const key = `doc:${documentId}:editors`;
    return redis.zcard(key);
  }

  async getPrimaryEditor(documentId: string): Promise<string | null> {
    const key = `doc:${documentId}:primary`;
    return redis.get(key);
  }

  async attemptTakeover(documentId: string, newSessionId: string): Promise<boolean> {
    const lockKey = `doc:${documentId}:primary`;

    const luaScript = `
      local current = redis.call('GET', KEYS[1])
      if current == false or current == ARGV[1] then
        redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
        return 1
      else
        return 0
      end
    `;

    const currentPrimary = await this.getPrimaryEditor(documentId);

    const result = await redis.eval(
      luaScript,
      1,
      [lockKey],
      [currentPrimary || '', newSessionId, PRIMARY_LOCK_TTL_SECONDS.toString()]
    );

    if (result === 1) {
      sseService.broadcastToDocument(documentId, 'editing-transferred', {
        newPrimaryEditor: newSessionId,
        previousEditor: currentPrimary,
        timestamp: new Date().toISOString(),
      });

      logger.info({ documentId, newSessionId, currentPrimary }, 'Editing transferred');
      return true;
    }

    return false;
  }

  async renewPrimaryLock(documentId: string, sessionId: string): Promise<boolean> {
    const lockKey = `doc:${documentId}:primary`;
    const currentPrimary = await this.getPrimaryEditor(documentId);

    if (currentPrimary === sessionId) {
      await redis.set(lockKey, sessionId, PRIMARY_LOCK_TTL_SECONDS);
      return true;
    }

    return false;
  }

  async isPrimaryEditor(documentId: string, sessionId: string): Promise<boolean> {
    const primary = await this.getPrimaryEditor(documentId);
    return primary === sessionId;
  }
}

export const presenceService = new PresenceService();
