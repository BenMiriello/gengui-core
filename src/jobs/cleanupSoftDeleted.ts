import { lt } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../config/database';
import { nodeMedia } from '../models/schema';
import { customStylePromptsService } from '../services/customStylePrompts';
import { graphService } from '../services/graph/graph.service';
import { logger } from '../utils/logger';

const CLEANUP_JOB_SCHEDULE = '0 2 * * *';
const RETENTION_DAYS = 31;

function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export function startCleanupJob(): ScheduledTask {
  const task = cron.schedule(CLEANUP_JOB_SCHEDULE, async () => {
    const threshold = getDaysAgo(RETENTION_DAYS);
    const results: Record<string, number> = {};

    try {
      // Clean up custom style prompts
      const stylePromptsCount =
        await customStylePromptsService.cleanupDeleted();
      if (stylePromptsCount > 0) results.stylePrompts = stylePromptsCount;

      // Clean up node_media associations (still in Postgres)
      const deletedNodeMedia = await db
        .delete(nodeMedia)
        .where(lt(nodeMedia.deletedAt, threshold))
        .returning({ id: nodeMedia.id });
      if (deletedNodeMedia.length > 0)
        results.nodeMedia = deletedNodeMedia.length;

      // Clean up story nodes and connections from FalkorDB
      const graphCleanup = await graphService.cleanupSoftDeleted(threshold);
      if (graphCleanup.nodes > 0) results.nodes = graphCleanup.nodes;
      if (graphCleanup.connections > 0)
        results.connections = graphCleanup.connections;

      if (Object.keys(results).length > 0) {
        logger.info({ results }, 'Soft delete cleanup job completed');
      }
    } catch (error) {
      logger.error({ error }, 'Soft delete cleanup job failed');
    }
  });

  logger.info('Soft delete cleanup job scheduled (runs daily at 2 AM)');
  return task;
}
