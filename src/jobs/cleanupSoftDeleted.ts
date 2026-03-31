import { and, gt, isNotNull, lt, lte } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../config/database';
import {
  documentMedia,
  documents,
  media,
  nodeMedia,
  users,
} from '../models/schema';
import { authService } from '../services/auth';
import { customStylePromptsService } from '../services/customStylePrompts';
import { emailService } from '../services/emailService';
import { graphService } from '../services/graph/graph.service';
import { mentionService } from '../services/mentions/mention.service';
import { logger } from '../utils/logger';

const CLEANUP_JOB_SCHEDULE = '0 2 * * *';
const RETENTION_DAYS = 31;

function getDaysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function getTomorrow(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(23, 59, 59, 999);
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

      // Before cleaning up FalkorDB nodes, clean up their mentions
      const nodeIdsToDelete =
        await graphService.getSoftDeletedNodeIds(threshold);
      if (nodeIdsToDelete.length > 0) {
        const mentionsDeleted =
          await mentionService.deleteOrphanedMentions(nodeIdsToDelete);
        if (mentionsDeleted > 0) results.mentions = mentionsDeleted;
      }

      // Also clean up orphaned mentions (from failed analysis, etc.)
      const orphanedMentions = await mentionService.deleteOrphanedMentions();
      if (orphanedMentions > 0) results.orphanedMentions = orphanedMentions;

      // Clean up story nodes and connections from FalkorDB
      const graphCleanup = await graphService.cleanupSoftDeleted(threshold);
      if (graphCleanup.nodes > 0) results.nodes = graphCleanup.nodes;
      if (graphCleanup.connections > 0)
        results.connections = graphCleanup.connections;

      // Clean up media
      const deletedMedia = await db
        .delete(media)
        .where(lt(media.deletedAt, threshold))
        .returning({ id: media.id });
      if (deletedMedia.length > 0) results.media = deletedMedia.length;

      // Clean up documents (cascades to related tables via FK)
      const deletedDocuments = await db
        .delete(documents)
        .where(lt(documents.deletedAt, threshold))
        .returning({ id: documents.id });
      if (deletedDocuments.length > 0)
        results.documents = deletedDocuments.length;

      // Clean up orphaned documentMedia links
      const deletedDocumentMedia = await db
        .delete(documentMedia)
        .where(lt(documentMedia.deletedAt, threshold))
        .returning({ id: documentMedia.id });
      if (deletedDocumentMedia.length > 0)
        results.documentMedia = deletedDocumentMedia.length;

      // Permanently delete users past their scheduled deletion date
      const now = new Date();
      const usersToDelete = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            isNotNull(users.scheduledDeletionAt),
            lte(users.scheduledDeletionAt, now),
          ),
        );

      for (const user of usersToDelete) {
        try {
          await authService.permanentlyDeleteUser(user.id);
          results.deletedUsers = (results.deletedUsers || 0) + 1;
        } catch (error) {
          logger.error(
            { error, userId: user.id },
            'Failed to permanently delete user',
          );
        }
      }

      // Send deletion reminders to users being deleted tomorrow
      const tomorrow = getTomorrow();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const usersToRemind = await db
        .select({
          id: users.id,
          email: users.email,
          scheduledDeletionAt: users.scheduledDeletionAt,
        })
        .from(users)
        .where(
          and(
            isNotNull(users.scheduledDeletionAt),
            gt(users.scheduledDeletionAt, today),
            lte(users.scheduledDeletionAt, tomorrow),
          ),
        );

      for (const user of usersToRemind) {
        if (user.scheduledDeletionAt) {
          try {
            await emailService.sendAccountDeletionReminder(
              user.email,
              user.scheduledDeletionAt,
            );
            results.deletionReminders = (results.deletionReminders || 0) + 1;
          } catch (error) {
            logger.error(
              { error, userId: user.id },
              'Failed to send deletion reminder',
            );
          }
        }
      }

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
