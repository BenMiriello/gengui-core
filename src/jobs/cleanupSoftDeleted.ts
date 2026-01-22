import cron from 'node-cron';
import { db } from '../config/database';
import { storyNodes, storyNodeConnections, nodeMedia } from '../models/schema';
import { lt } from 'drizzle-orm';
import { customStylePromptsService } from '../services/customStylePrompts';
import { logger } from '../utils/logger';

const CLEANUP_JOB_SCHEDULE = '0 2 * * *';
const RETENTION_DAYS = 31;

function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export function startCleanupJob() {
  cron.schedule(CLEANUP_JOB_SCHEDULE, async () => {
    const threshold = getDaysAgo(RETENTION_DAYS);
    const results: Record<string, number> = {};

    try {
      // Clean up custom style prompts
      const stylePromptsCount = await customStylePromptsService.cleanupDeleted();
      if (stylePromptsCount > 0) results.stylePrompts = stylePromptsCount;

      // Clean up story node connections (must be before nodes due to FK)
      const deletedConnections = await db
        .delete(storyNodeConnections)
        .where(lt(storyNodeConnections.deletedAt, threshold))
        .returning({ id: storyNodeConnections.id });
      if (deletedConnections.length > 0) results.connections = deletedConnections.length;

      // Clean up node_media associations
      const deletedNodeMedia = await db
        .delete(nodeMedia)
        .where(lt(nodeMedia.deletedAt, threshold))
        .returning({ id: nodeMedia.id });
      if (deletedNodeMedia.length > 0) results.nodeMedia = deletedNodeMedia.length;

      // Clean up story nodes
      const deletedNodes = await db
        .delete(storyNodes)
        .where(lt(storyNodes.deletedAt, threshold))
        .returning({ id: storyNodes.id });
      if (deletedNodes.length > 0) results.nodes = deletedNodes.length;

      if (Object.keys(results).length > 0) {
        logger.info({ results }, 'Soft delete cleanup job completed');
      }
    } catch (error) {
      logger.error({ error }, 'Soft delete cleanup job failed');
    }
  });

  logger.info('Soft delete cleanup job scheduled (runs daily at 2 AM)');
}
